import { Router } from "express";
import { z } from "zod";
import {
  getContacts,
  getHistory,
  getSessionQr,
  getSessionStatus,
  markRead,
  sendMessage,
  sendPresence,
  startSession,
  stopSession,
} from "../baileys/sessionManager";

export const sessionsRouter = Router();

const createSessionSchema = z.object({
  sessionId: z.string().min(1),
  webhookUrl: z.string().url().optional(),
});

sessionsRouter.post("/", async (req, res) => {
  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  await startSession(parsed.data.sessionId, parsed.data.webhookUrl);
  const status = await getSessionStatus(parsed.data.sessionId);
  res.status(201).json({ sessionId: parsed.data.sessionId, status });
});

sessionsRouter.get("/:id/qr", async (req, res) => {
  const qr = await getSessionQr(req.params.id);
  if (!qr) {
    res.status(404).json({ error: "QR not available" });
    return;
  }
  res.json({ qr });
});

sessionsRouter.get("/:id/status", async (req, res) => {
  const status = await getSessionStatus(req.params.id);
  res.json({ status });
});

sessionsRouter.delete("/:id", async (req, res) => {
  await stopSession(req.params.id);
  res.status(204).send();
});

const sendMessageSchema = z.object({
  to: z.string().min(1),
  type: z.enum(["text", "image", "document", "audio"]),
  content: z.string(),
  mediaUrl: z.string().url().optional(),
});

sessionsRouter.post("/:id/messages", async (req, res) => {
  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const { to, type, content, mediaUrl } = parsed.data;
    const result = await sendMessage(req.params.id, to, type, content, mediaUrl);
    res.status(202).json({ id: result.messageId });
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

sessionsRouter.get("/:id/contacts", (req, res) => {
  res.json({ contacts: getContacts(req.params.id) });
});

sessionsRouter.get("/:id/chats/:number/history", (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  res.json({ messages: getHistory(req.params.id, req.params.number, limit) });
});

const presenceSchema = z.object({
  jid: z.string().min(1),
  presence: z.enum(["composing", "available", "unavailable", "paused"]),
});

sessionsRouter.post("/:id/presence", async (req, res) => {
  const parsed = presenceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    await sendPresence(req.params.id, parsed.data.jid, parsed.data.presence);
    res.status(204).send();
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

const readSchema = z.object({
  keys: z
    .array(
      z.object({
        remoteJid: z.string(),
        id: z.string(),
        fromMe: z.boolean().optional(),
      })
    )
    .min(1),
});

sessionsRouter.post("/:id/read", async (req, res) => {
  const parsed = readSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    await markRead(req.params.id, parsed.data.keys);
    res.status(204).send();
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});
