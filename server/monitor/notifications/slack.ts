import { redactSecrets } from "../../lib/redact.js";
import type { NotificationDeliveryResult, NotificationDestination, NotificationPayload } from "./types.js";

function buildBlocks(payload: NotificationPayload): unknown[] {
  const { incident, eventType, check } = payload;
  const emojiMap: Record<string, string> = {
    opened: ":rotating_light:",
    resolved: ":white_check_mark:",
    escalated: ":arrow_double_up:",
    muted: ":mute:",
  };
  const headingMap: Record<string, string> = {
    opened: "Incident Opened",
    resolved: "Incident Resolved",
    escalated: "Incident Escalated",
    muted: "Incident Muted (Flapping)",
  };
  const emoji = emojiMap[eventType] ?? ":question:";
  const heading = headingMap[eventType] ?? "Incident Update";

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} ${heading}` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Severity:*\n${incident.severity}` },
        { type: "mrkdwn", text: `*Check:*\n${incident.check_type}` },
        { type: "mrkdwn", text: `*Target:*\n${incident.target_key}` },
        { type: "mrkdwn", text: `*Status:*\n${check.status}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Summary:* ${redactSecrets(check.summary)}` },
    },
  ];
}

export class SlackDestination implements NotificationDestination {
  readonly id = "slack";
  readonly name = "Slack";

  constructor(private readonly webhookUrl: string | null) {}

  isEnabled(): boolean {
    return !!this.webhookUrl;
  }

  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    if (!this.webhookUrl) {
      return { success: false, errorMessage: "Slack webhook URL not configured" };
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks: buildBlocks(payload) }),
      });

      const body = await response.text();

      if (!response.ok) {
        return { success: false, statusCode: response.status, responseBody: body, errorMessage: `Slack webhook error: ${response.status}` };
      }

      return { success: true, statusCode: response.status, responseBody: body };
    } catch (error) {
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  }
}
