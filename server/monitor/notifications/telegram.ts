import fs from "node:fs";

import { redactSecrets } from "../../lib/redact.js";
import type { IncidentRecord, MonitorCheckResultInput } from "../types.js";
import type { NotificationDeliveryResult, NotificationDestination, NotificationPayload } from "./types.js";

type EventType = NotificationPayload["eventType"];

function escapeTelegram(value: string): string {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

const EVENT_HEADINGS: Record<EventType, string> = {
  opened: "Incident opened",
  resolved: "Incident resolved",
  escalated: "Incident escalated",
  muted: "Incident muted (flapping)",
};

function buildMessage(incident: IncidentRecord, eventType: EventType, check: MonitorCheckResultInput): string {
  const heading = EVENT_HEADINGS[eventType];
  return redactSecrets([
    `*${escapeTelegram(heading)}*`,
    `Severity: ${escapeTelegram(incident.severity)}`,
    `Check: ${escapeTelegram(incident.check_type)}`,
    `Target: ${escapeTelegram(incident.target_key)}`,
    `Status: ${escapeTelegram(check.status)}`,
    `Summary: ${escapeTelegram(check.summary)}`,
    `Workspace: ${escapeTelegram(check.workspaceId)}`,
  ].join("\n"));
}

export class TelegramDestination implements NotificationDestination {
  readonly id = "telegram";
  readonly name = "Telegram";

  constructor(
    private readonly botToken: string | null,
    private readonly chatId: string | null,
    private readonly topicId: string | null = null,
  ) {}

  isEnabled(): boolean {
    return !!(this.botToken && this.chatId);
  }

  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    if (!this.botToken || !this.chatId) {
      return { success: false, errorMessage: "Telegram not configured" };
    }

    try {
      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          ...(this.topicId ? { message_thread_id: Number(this.topicId) } : {}),
          text: buildMessage(payload.incident, payload.eventType, payload.check),
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
        }),
      });

      const body = await response.text();

      if (!response.ok) {
        return { success: false, statusCode: response.status, responseBody: body, errorMessage: `Telegram API error: ${response.status}` };
      }

      return { success: true, statusCode: response.status, responseBody: body };
    } catch (error) {
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  }

  async sendRaw(text: string): Promise<NotificationDeliveryResult> {
    if (!this.botToken || !this.chatId) {
      return { success: false, errorMessage: "Telegram not configured" };
    }

    try {
      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          ...(this.topicId ? { message_thread_id: Number(this.topicId) } : {}),
          text,
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
        }),
      });

      const body = await response.text();

      if (!response.ok) {
        return { success: false, statusCode: response.status, responseBody: body, errorMessage: `Telegram API error: ${response.status}` };
      }

      return { success: true, statusCode: response.status, responseBody: body };
    } catch (error) {
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  }

  async sendPhoto(filePath: string, caption?: string): Promise<NotificationDeliveryResult> {
    if (!this.botToken || !this.chatId) {
      return { success: false, errorMessage: "Telegram not configured" };
    }

    try {
      const form = new FormData();
      form.append("chat_id", this.chatId);
      if (this.topicId) form.append("message_thread_id", this.topicId);
      if (caption) {
        form.append("caption", caption);
        form.append("parse_mode", "MarkdownV2");
      }

      const fileBuffer = fs.readFileSync(filePath);
      const fileName = filePath.split("/").pop() ?? "digest.png";
      form.append("photo", new Blob([fileBuffer]), fileName);

      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendPhoto`, {
        method: "POST",
        body: form,
      });

      const body = await response.text();

      if (!response.ok) {
        return { success: false, statusCode: response.status, responseBody: body, errorMessage: `Telegram API error: ${response.status}` };
      }

      return { success: true, statusCode: response.status, responseBody: body };
    } catch (error) {
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  }

  async sendDocument(filePath: string, caption?: string): Promise<NotificationDeliveryResult> {
    if (!this.botToken || !this.chatId) {
      return { success: false, errorMessage: "Telegram not configured" };
    }

    try {
      const form = new FormData();
      form.append("chat_id", this.chatId);
      if (this.topicId) form.append("message_thread_id", this.topicId);
      if (caption) {
        form.append("caption", caption);
        form.append("parse_mode", "MarkdownV2");
      }

      const fileBuffer = fs.readFileSync(filePath);
      const fileName = filePath.split("/").pop() ?? "report.pdf";
      form.append("document", new Blob([fileBuffer]), fileName);

      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendDocument`, {
        method: "POST",
        body: form,
      });

      const body = await response.text();

      if (!response.ok) {
        return { success: false, statusCode: response.status, responseBody: body, errorMessage: `Telegram API error: ${response.status}` };
      }

      return { success: true, statusCode: response.status, responseBody: body };
    } catch (error) {
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  }
}
