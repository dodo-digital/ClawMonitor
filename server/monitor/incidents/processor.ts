import type { IncidentRecord, MonitorCheckResultInput } from "../types.js";
import {
  getActiveIncidentByCheckTarget,
  getActiveIncidentByDedupeKey,
  getRecentlyResolvedByDedupeKey,
  insertCheckResult,
  insertIncidentEvent,
  openIncident,
  resolveIncident,
  updateIncidentSeen,
} from "./store.js";

export type IncidentNotificationHandler = (input: {
  incident: IncidentRecord;
  eventType: "opened" | "resolved";
  check: MonitorCheckResultInput;
}) => Promise<void>;

const REOPEN_COOLDOWN_MINUTES = 30;

export class IncidentProcessor {
  constructor(private readonly notify: IncidentNotificationHandler) {}

  async processCheck(input: MonitorCheckResultInput): Promise<void> {
    const result = insertCheckResult(input);
    const activeIncident = getActiveIncidentByDedupeKey(input.workspaceId, input.dedupeKey);
    const shouldOpenIncident = input.status === "failing" || input.status === "degraded" || input.status === "unknown";

    if (shouldOpenIncident) {
      if (activeIncident) {
        updateIncidentSeen(activeIncident.id, input);
        return;
      }

      // Don't reopen if the same issue was resolved within the cooldown window.
      // This prevents flapping checks from spamming notifications.
      const recentlyResolved = getRecentlyResolvedByDedupeKey(input.workspaceId, input.dedupeKey, REOPEN_COOLDOWN_MINUTES);
      if (recentlyResolved) {
        return;
      }

      const incident = openIncident(input);
      insertIncidentEvent(incident.id, "opened", {
        checkResultId: result.id,
        status: input.status,
        severity: input.severity,
        summary: input.summary,
        evidence: input.evidence,
      });
      try {
        await this.notify({ incident, eventType: "opened", check: input });
      } catch (error) {
        console.error("[monitor] failed to send open notification", error);
      }
      return;
    }

    const activeByTarget = getActiveIncidentByCheckTarget(input.workspaceId, input.checkType, input.targetKey);

    if (!activeByTarget) {
      return;
    }

    const resolved = resolveIncident(activeByTarget.id, input.observedAt, input.summary);
    insertIncidentEvent(resolved.id, "resolved", {
      checkResultId: result.id,
      status: input.status,
      severity: input.severity,
      summary: input.summary,
      evidence: input.evidence,
    });
    try {
      await this.notify({ incident: resolved, eventType: "resolved", check: input });
    } catch (error) {
      console.error("[monitor] failed to send resolve notification", error);
    }
  }
}
