import crypto from "node:crypto";

import type { NotificationDeliveryResult, NotificationDestination, NotificationPayload } from "./types.js";

export function computeSignature(secret: string, timestamp: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export class WebhookDestination implements NotificationDestination {
  readonly id = "webhook";
  readonly name = "Webhook";

  constructor(
    private readonly url: string | null,
    private readonly secret: string | null,
  ) {}

  isEnabled(): boolean {
    return !!this.url;
  }

  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    if (!this.url) {
      return { success: false, errorMessage: "Webhook URL not configured" };
    }

    try {
      const body = JSON.stringify(payload);
      const timestamp = Math.floor(Date.now() / 1000).toString();

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-ClawMonitor-Timestamp": timestamp,
        "X-ClawMonitor-Event": payload.eventType,
      };

      if (this.secret) {
        const signature = computeSignature(this.secret, timestamp, body);
        headers["X-ClawMonitor-Signature"] = `sha256=${signature}`;
      }

      const response = await fetch(this.url, {
        method: "POST",
        headers,
        body,
      });

      const responseBody = await response.text();

      if (!response.ok) {
        return { success: false, statusCode: response.status, responseBody, errorMessage: `Webhook error: ${response.status}` };
      }

      return { success: true, statusCode: response.status, responseBody };
    } catch (error) {
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  }
}
