import crypto from "crypto";
import { config } from "../config";
import { logger } from "../logger";

export type WebhookEvent =
  | { type: "message.received"; sessionId: string; data: { from: string; content: string | null; id: string; mediaUrl: string | null; timestamp: number } }
  | { type: "message.status"; sessionId: string; data: { id: string; status: "sent" | "delivered" | "read" | "failed" } }
  | { type: "session.status"; sessionId: string; data: { status: string } }
  | { type: "qr.updated"; sessionId: string; data: { qr: string } };

export async function dispatchWebhook(event: WebhookEvent): Promise<void> {
  const body = JSON.stringify(event);
  const signature = `sha256=${crypto.createHmac("sha256", config.webhookSecret).update(body).digest("hex")}`;

  try {
    const res = await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": signature },
      body,
    });
    if (!res.ok) {
      logger.warn({ event: event.type, status: res.status }, "webhook responded with non-2xx status");
    }
  } catch (err) {
    logger.error({ err, event: event.type }, "failed to dispatch webhook");
  }
}
