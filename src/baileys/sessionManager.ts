import makeWASocket, {
  DisconnectReason,
  WASocket,
  WAMessage,
  proto,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";
import { config } from "../config";
import { prisma } from "../db/prisma";
import { logger } from "../logger";
import { dispatchWebhook } from "../webhook/dispatcher";
import { clearAuthState, useDbAuthState } from "./dbAuthState";

export type SessionStatus = "disconnected" | "qr" | "connecting" | "connected";

interface SessionEntry {
  sock: WASocket;
  status: SessionStatus;
  qr: string | null;
  webhookUrl: string | null;
  contacts: Map<string, { id: string; name: string | null }>;
  history: Map<string, WAMessage[]>;
}

const sessions = new Map<string, SessionEntry>();
const HISTORY_LIMIT_PER_CHAT = 200;

function statusToWebhookStatus(update: proto.WebMessageInfo.Status | number | null | undefined): "sent" | "delivered" | "read" | "failed" | null {
  switch (update) {
    case proto.WebMessageInfo.Status.SERVER_ACK:
      return "sent";
    case proto.WebMessageInfo.Status.DELIVERY_ACK:
      return "delivered";
    case proto.WebMessageInfo.Status.READ:
    case proto.WebMessageInfo.Status.PLAYED:
      return "read";
    case proto.WebMessageInfo.Status.ERROR:
      return "failed";
    default:
      return null;
  }
}

async function setStatus(
  sessionId: string,
  status: SessionStatus,
  webhookUrl: string | null,
  qr: string | null = null
): Promise<void> {
  const entry = sessions.get(sessionId);
  if (entry) {
    entry.status = status;
    entry.qr = qr;
  }
  await prisma.session
    .upsert({
      where: { id: sessionId },
      create: { id: sessionId, status, qr },
      update: { status, qr },
    })
    .catch((err) => logger.error({ err, sessionId }, "failed to persist session status"));
  await dispatchWebhook({ type: "session.status", sessionId, data: { status } }, webhookUrl);
}

export async function startSession(sessionId: string, webhookUrl?: string): Promise<void> {
  if (sessions.has(sessionId)) return;

  const existingRow = await prisma.session.findUnique({ where: { id: sessionId } });
  const resolvedWebhookUrl = webhookUrl ?? existingRow?.webhookUrl ?? config.webhookUrl ?? null;

  if (webhookUrl && webhookUrl !== existingRow?.webhookUrl) {
    await prisma.session.upsert({
      where: { id: sessionId },
      create: { id: sessionId, webhookUrl },
      update: { webhookUrl },
    });
  }

  const { state, saveCreds } = await useDbAuthState(sessionId);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    logger: logger.child({ sessionId }) as any,
  });

  const entry: SessionEntry = {
    sock,
    status: "connecting",
    qr: null,
    webhookUrl: resolvedWebhookUrl,
    contacts: new Map(),
    history: new Map(),
  };
  sessions.set(sessionId, entry);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrImage = await QRCode.toDataURL(qr);
      await setStatus(sessionId, "qr", entry.webhookUrl, qrImage);
      await dispatchWebhook({ type: "qr.updated", sessionId, data: { qr: qrImage } }, entry.webhookUrl);
    }

    if (connection === "open") {
      await setStatus(sessionId, "connected", entry.webhookUrl);
    } else if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      sessions.delete(sessionId);
      if (loggedOut) {
        await clearAuthState(sessionId);
        await setStatus(sessionId, "disconnected", entry.webhookUrl);
      } else {
        await setStatus(sessionId, "disconnected", entry.webhookUrl);
        setTimeout(() => {
          startSession(sessionId).catch((err) => logger.error({ err, sessionId }, "failed to reconnect session"));
        }, 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid) continue;

      const chatHistory = entry.history.get(jid) ?? [];
      chatHistory.push(msg);
      if (chatHistory.length > HISTORY_LIMIT_PER_CHAT) chatHistory.shift();
      entry.history.set(jid, chatHistory);

      if (msg.key.fromMe || !msg.key.id) continue;

      const content =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        msg.message?.imageMessage?.caption ??
        msg.message?.videoMessage?.caption ??
        null;

      let mediaUrl: string | null = null;
      const mediaMessage =
        msg.message?.imageMessage ?? msg.message?.videoMessage ?? msg.message?.documentMessage ?? msg.message?.audioMessage;
      if (mediaMessage) {
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          mediaUrl = `data:${mediaMessage.mimetype ?? "application/octet-stream"};base64,${(buffer as Buffer).toString("base64")}`;
        } catch (err) {
          logger.error({ err, sessionId }, "failed to download media message");
        }
      }

      await dispatchWebhook(
        {
          type: "message.received",
          sessionId,
          data: {
            from: jid,
            content,
            id: msg.key.id,
            mediaUrl,
            timestamp: Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000)),
          },
        },
        entry.webhookUrl
      );
    }
  });

  sock.ev.on("messages.update", async (updates) => {
    for (const { key, update } of updates) {
      const status = statusToWebhookStatus(update.status);
      if (status && key.id) {
        await dispatchWebhook({ type: "message.status", sessionId, data: { id: key.id, status } }, entry.webhookUrl);
      }
    }
  });

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      entry.contacts.set(c.id, { id: c.id, name: c.name ?? c.notify ?? null });
    }
  });

  sock.ev.on("contacts.update", (contacts) => {
    for (const c of contacts) {
      if (!c.id) continue;
      const existing = entry.contacts.get(c.id) ?? { id: c.id, name: null };
      entry.contacts.set(c.id, { id: c.id, name: c.name ?? c.notify ?? existing.name });
    }
  });
}

export function getSession(sessionId: string): SessionEntry | undefined {
  return sessions.get(sessionId);
}

export async function getSessionStatus(sessionId: string): Promise<SessionStatus> {
  const entry = sessions.get(sessionId);
  if (entry) return entry.status;
  const row = await prisma.session.findUnique({ where: { id: sessionId } });
  return (row?.status as SessionStatus) ?? "disconnected";
}

export async function getSessionQr(sessionId: string): Promise<string | null> {
  const entry = sessions.get(sessionId);
  if (entry) return entry.qr;
  const row = await prisma.session.findUnique({ where: { id: sessionId } });
  return row?.qr ?? null;
}

export async function stopSession(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (entry) {
    await entry.sock.logout().catch(() => undefined);
    sessions.delete(sessionId);
  }
  await clearAuthState(sessionId);
}

function toJid(to: string): string {
  if (to.includes("@")) return to;
  return `${to.replace(/\D/g, "")}@s.whatsapp.net`;
}

export async function sendMessage(
  sessionId: string,
  to: string,
  type: "text" | "image" | "document" | "audio",
  content: string,
  mediaUrl?: string
): Promise<{ messageId: string }> {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error("Session not connected");

  const jid = toJid(to);
  let sent: proto.WebMessageInfo | undefined;

  if (type === "text") {
    sent = await entry.sock.sendMessage(jid, { text: content });
  } else if (!mediaUrl) {
    throw new Error("mediaUrl is required for media messages");
  } else if (type === "image") {
    sent = await entry.sock.sendMessage(jid, { image: { url: mediaUrl }, caption: content });
  } else if (type === "document") {
    sent = await entry.sock.sendMessage(jid, { document: { url: mediaUrl }, mimetype: "application/octet-stream", fileName: content });
  } else if (type === "audio") {
    sent = await entry.sock.sendMessage(jid, { audio: { url: mediaUrl }, mimetype: "audio/mp4" });
  }

  if (!sent?.key.id) throw new Error("Failed to send message");
  return { messageId: sent.key.id };
}

export function getContacts(sessionId: string): { id: string; name: string | null }[] {
  const entry = sessions.get(sessionId);
  if (!entry) return [];
  return Array.from(entry.contacts.values());
}

export function getHistory(sessionId: string, number: string, limit: number): WAMessage[] {
  const entry = sessions.get(sessionId);
  if (!entry) return [];
  const jid = toJid(number);
  const chatHistory = entry.history.get(jid) ?? [];
  return chatHistory.slice(-limit);
}

export async function sendPresence(
  sessionId: string,
  jid: string,
  presence: "composing" | "available" | "unavailable" | "paused"
): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error("Session not connected");
  await entry.sock.sendPresenceUpdate(presence, toJid(jid));
}

export async function markRead(sessionId: string, keys: proto.IMessageKey[]): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error("Session not connected");
  await entry.sock.readMessages(keys);
}
