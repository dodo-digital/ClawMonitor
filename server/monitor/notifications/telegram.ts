import fs from "node:fs";

import { redactSecrets } from "../../lib/redact.js";
import type { IncidentRecord, MonitorCheckResultInput } from "../types.js";
import type { NotificationDeliveryResult, NotificationDestination, NotificationPayload } from "./types.js";

type EventType = NotificationPayload["eventType"];

function escapeTelegram(value: string): string {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

const EVENT_EMOJI: Record<EventType, string> = {
  opened: "\u{1F6A8}",    // 🚨
  resolved: "\u2705",      // ✅
  escalated: "\u{1F525}",  // 🔥
  muted: "\u{1F507}",      // 🔇
};

const EVENT_HEADINGS: Record<EventType, string> = {
  opened: "Incident opened",
  resolved: "Incident resolved",
  escalated: "Incident escalated",
  muted: "Incident muted (flapping)",
};

// Suggest diagnostic commands based on check type
const DIAGNOSTIC_COMMANDS: Record<string, string[]> = {
  "gateway.connection": [
    "systemctl --user status openclaw-gateway",
    "journalctl --user -u openclaw-gateway -n 30 --no-pager",
    "fuser -v 18789/tcp",
  ],
  "gateway.post_update": [
    "journalctl --user -u openclaw-gateway -n 30 --no-pager",
    "openclaw doctor --fix",
    "cat ~/.openclaw/watchdog-state.json",
  ],
  "cron.job_status": [
    "cron-cli list --status failing",
    "cron-cli debug {target}",
  ],
  "cron.job_staleness": [
    "cron-cli debug {target}",
    "cron-cli health",
  ],
  "cron.schedule_drift": [
    "cron-cli debug {target}",
    "cron-cli show {target}",
  ],
  "auth.profile_integrity": [
    "monitor status",
    "cat ~/.openclaw/agents/direct/agent/auth-profiles.json | python3 -m json.tool",
  ],
  "exec.security_config": [
    "monitor status",
    "cat ~/.openclaw/exec-approvals.json | python3 -m json.tool",
  ],
  "system.disk": [
    "df -h /",
    "du -sh ~/.openclaw/* | sort -rh | head -10",
  ],
};

function formatEvidence(evidence: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (key === "job" || key === "evidence") continue; // skip nested objects
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue; // skip complex nested data
    lines.push(`${key}: ${String(value)}`);
  }
  return lines.slice(0, 6).join("\n"); // cap at 6 key facts
}

function buildMessage(incident: IncidentRecord, eventType: EventType, check: MonitorCheckResultInput): string {
  const emoji = EVENT_EMOJI[eventType];
  const heading = EVENT_HEADINGS[eventType];
  const esc = escapeTelegram;

  const lines: string[] = [
    `${emoji} *${esc(heading)}* \\(${esc(incident.severity)}\\)`,
    ``,
    `*${esc(incident.title)}*`,
    `${esc(check.summary)}`,
  ];

  // Add key evidence facts
  const evidenceSummary = formatEvidence(check.evidence);
  if (evidenceSummary) {
    lines.push(``);
    lines.push(`\`\`\``);
    lines.push(evidenceSummary);
    lines.push(`\`\`\``);
  }

  // Add incident reference
  lines.push(``);
  lines.push(`Incident \\#${incident.id} \\| ${esc(incident.check_type)}`);

  // Add diagnostic commands for opened/escalated incidents
  if (eventType === "opened" || eventType === "escalated") {
    const commands = DIAGNOSTIC_COMMANDS[incident.check_type];
    if (commands) {
      lines.push(``);
      lines.push(`*Diagnose:*`);
      for (const cmd of commands) {
        const resolved = cmd.replace("{target}", incident.target_key);
        lines.push(`\`${esc(resolved)}\``);
      }
    }

    lines.push(``);
    lines.push(`_Reply to this message to investigate or fix\\._`);
  }

  return redactSecrets(lines.join("\n"));
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
