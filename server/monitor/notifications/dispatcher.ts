import type { IncidentNotificationHandler } from "../incidents/processor.js";
import { recordNotificationDelivery } from "./delivery-store.js";
import { sendDigest } from "./digest.js";
import type { NotificationDestination, NotificationPayload } from "./types.js";

export type NotificationMode = "realtime" | "digest";

export class NotificationDispatcher {
  private readonly destinations: NotificationDestination[] = [];

  constructor(private readonly mode: NotificationMode = "digest") {}

  register(destination: NotificationDestination): void {
    this.destinations.push(destination);
  }

  /** Returns a handler compatible with IncidentProcessor's constructor. */
  toHandler(): IncidentNotificationHandler {
    return async (payload: NotificationPayload) => {
      // In digest mode, incidents are still tracked in the DB but
      // individual notifications are suppressed. The daily digest
      // covers them instead.
      if (this.mode === "digest") {
        return;
      }

      const enabled = this.destinations.filter((d) => d.isEnabled());

      await Promise.allSettled(
        enabled.map(async (dest) => {
          let result;
          try {
            result = await dest.send(payload);
          } catch (error) {
            result = {
              success: false,
              errorMessage: error instanceof Error ? error.message : String(error),
            };
          }

          try {
            recordNotificationDelivery({
              incidentId: payload.incident.id,
              eventType: payload.eventType,
              destinationId: dest.id,
              destinationName: dest.name,
              success: result.success,
              statusCode: result.statusCode ?? null,
              responseBody: result.responseBody ?? null,
              errorMessage: result.errorMessage ?? null,
            });
          } catch (dbError) {
            console.error(`[notify:${dest.id}] failed to record delivery`, dbError);
          }

          if (!result.success) {
            console.error(`[notify:${dest.id}] delivery failed: ${result.errorMessage}`);
          }
        }),
      );
    };
  }

  /** Send the daily digest to all enabled destinations. */
  async sendDailyDigest(): Promise<void> {
    await sendDigest(this.destinations);
  }
}
