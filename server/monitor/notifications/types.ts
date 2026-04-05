import type { IncidentRecord, MonitorCheckResultInput } from "../types.js";

export type NotificationPayload = {
  incident: IncidentRecord;
  eventType: "opened" | "resolved" | "escalated" | "muted";
  check: MonitorCheckResultInput;
};

export type NotificationDeliveryResult = {
  success: boolean;
  statusCode?: number;
  responseBody?: string;
  errorMessage?: string;
};

export interface NotificationDestination {
  /** Unique identifier, e.g. "telegram", "slack", "webhook" */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Returns true if the destination has the required configuration to operate */
  isEnabled(): boolean;
  /** Send a notification. Must not throw — return a failure result instead. */
  send(payload: NotificationPayload): Promise<NotificationDeliveryResult>;
  /** Send a pre-formatted text message (used by daily digest). Optional. */
  sendRaw?(text: string): Promise<NotificationDeliveryResult>;
}
