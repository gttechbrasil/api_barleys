import crypto from "crypto";
import { config } from "../config";
import { logger } from "../logger";

export type WebhookEvent =
  | { type: "message.received"; sessionId: string; data: { from: string; content: string | null; id: string; mediaUrl: string | null; timestamp: number } }
  | { type: "message.status"; sessionId: string; data: { id: string; status: "sent" | "delivered" | "read" | "failed" } }
  | { type: "session.status"; sessionId: string; data: { status: string } }
  | { type: "qr.updated"; sessionId: string; data: { qr: string } };

export async function dispatchWebhook(event: WebhookEvent, webhookUrl: string | null | undefined): Promise<void> {
  if (!webhookUrl) {
    logger.warn({ event: event.type, sessionId: event.sessionId }, "no webhookUrl configured for session, skipping dispatch");
    return;
  }

  const body = JSON.stringify(event);
  const signature = `sha256=${crypto.createHmac("sha256", config.webhookSecret).update(body).digest("hex")}`;

  logger.info({ event: event.type, sessionId: event.sessionId, webhookUrl }, "dispatching webhook");

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": signature },
      body,
    });
    const responseBody = await res.text().catch(() => "");
    if (!res.ok) {
      logger.warn({ event: event.type, status: res.status, responseBody }, "webhook responded with non-2xx status");
    } else {
      logger.info({ event: event.type, status: res.status }, "webhook dispatched successfully");
    }
  } catch (err) {
    logger.error({ err, event: event.type, webhookUrl }, "failed to dispatch webhook");
  }
}
