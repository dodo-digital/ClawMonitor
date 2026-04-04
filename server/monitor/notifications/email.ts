import type { NotificationDeliveryResult, NotificationDestination, NotificationPayload } from "./types.js";

function buildSubject(payload: NotificationPayload): string {
  const prefix = payload.eventType === "opened" ? "INCIDENT" : "RESOLVED";
  return `[ClawMonitor] ${prefix}: ${payload.incident.title}`;
}

function buildBody(payload: NotificationPayload): string {
  const { incident, eventType, check } = payload;
  const heading = eventType === "opened" ? "Incident Opened" : "Incident Resolved";

  return [
    heading,
    "=".repeat(heading.length),
    "",
    `Severity: ${incident.severity}`,
    `Check: ${incident.check_type}`,
    `Target: ${incident.target_key}`,
    `Status: ${check.status}`,
    `Summary: ${check.summary}`,
    `Workspace: ${check.workspaceId}`,
    "",
    `Opened: ${incident.opened_at}`,
    incident.resolved_at ? `Resolved: ${incident.resolved_at}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export class EmailDestination implements NotificationDestination {
  readonly id = "email";
  readonly name = "Email";

  constructor(
    private readonly endpoint: string | null,
    private readonly apiKey: string | null,
    private readonly from: string | null,
    private readonly to: string | null,
  ) {}

  isEnabled(): boolean {
    return !!(this.endpoint && this.to);
  }

  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    if (!this.endpoint || !this.to) {
      return { success: false, errorMessage: "Email not configured" };
    }

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: this.from ?? "clawmonitor@localhost",
          to: this.to.split(",").map((addr) => addr.trim()),
          subject: buildSubject(payload),
          text: buildBody(payload),
        }),
      });

      const body = await response.text();

      if (!response.ok) {
        return { success: false, statusCode: response.status, responseBody: body, errorMessage: `Email API error: ${response.status}` };
      }

      return { success: true, statusCode: response.status, responseBody: body };
    } catch (error) {
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  }
}
