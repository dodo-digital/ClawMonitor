/**
 * Incident processor with flap detection, exponential cooldown, and auto-escalation.
 *
 * Flap detection and cooldown logic adapted from openclaw-ops (MIT License, Cathryn Lavery).
 * @see https://github.com/cathrynlavery/openclaw-ops
 */

import type { IncidentRecord, MonitorCheckResultInput } from "../types.js";
import {
  escalateIncident,
  getActiveIncidentByCheckTarget,
  getActiveIncidentByDedupeKey,
  getEscalationCandidates,
  getRecentlyResolvedByDedupeKey,
  getRecentReopenCount,
  insertCheckResult,
  insertIncidentEvent,
  openIncident,
  resolveIncident,
  updateIncidentSeen,
} from "./store.js";

export type IncidentNotificationHandler = (input: {
  incident: IncidentRecord;
  eventType: "opened" | "resolved" | "escalated" | "muted";
  check: MonitorCheckResultInput;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Flap detection: auto-mute after too many transitions in a window
// ---------------------------------------------------------------------------

const FLAP_WINDOW_MS = 60 * 60_000; // 1 hour
const FLAP_THRESHOLD = 4; // transitions before muting

type FlapEntry = {
  transitions: number;
  windowStart: number;
  muted: boolean;
};

// ---------------------------------------------------------------------------
// Cooldown: exponential backoff on repeated reopens
// ---------------------------------------------------------------------------

const BASE_COOLDOWN_MINUTES = 30;
const MAX_COOLDOWN_MINUTES = 240;

function getCooldownMinutes(reopenCount: number): number {
  return Math.min(BASE_COOLDOWN_MINUTES * Math.pow(2, reopenCount), MAX_COOLDOWN_MINUTES);
}

// ---------------------------------------------------------------------------
// Auto-escalation: promote long-lived warnings to critical
// ---------------------------------------------------------------------------

const ESCALATION_AGE_MINUTES = 120; // 2 hours

export class IncidentProcessor {
  private readonly flapTracker = new Map<string, FlapEntry>();

  constructor(private readonly notify: IncidentNotificationHandler) {}

  private trackTransition(dedupeKey: string): boolean {
    const now = Date.now();
    let entry = this.flapTracker.get(dedupeKey);

    if (!entry || now - entry.windowStart > FLAP_WINDOW_MS) {
      entry = { transitions: 0, windowStart: now, muted: false };
    }

    entry.transitions++;

    if (entry.transitions >= FLAP_THRESHOLD && !entry.muted) {
      entry.muted = true;
    }

    this.flapTracker.set(dedupeKey, entry);
    return entry.muted;
  }

  private isMuted(dedupeKey: string): boolean {
    const entry = this.flapTracker.get(dedupeKey);
    if (!entry) return false;
    // Reset if window has expired
    if (Date.now() - entry.windowStart > FLAP_WINDOW_MS) {
      this.flapTracker.delete(dedupeKey);
      return false;
    }
    return entry.muted;
  }

  async processCheck(input: MonitorCheckResultInput): Promise<void> {
    const result = insertCheckResult(input);
    const activeIncident = getActiveIncidentByDedupeKey(input.workspaceId, input.dedupeKey);
    const shouldOpenIncident = input.status === "failing" || input.status === "degraded" || input.status === "unknown";

    if (shouldOpenIncident) {
      if (activeIncident) {
        updateIncidentSeen(activeIncident.id, input);
        return;
      }

      // Exponential cooldown: check recent reopen count for this dedupe key
      const reopenCount = getRecentReopenCount(input.workspaceId, input.dedupeKey);
      const cooldownMinutes = getCooldownMinutes(reopenCount);
      const recentlyResolved = getRecentlyResolvedByDedupeKey(input.workspaceId, input.dedupeKey, cooldownMinutes);
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

      // Track transition for flap detection
      const muted = this.trackTransition(input.dedupeKey);

      if (muted) {
        insertIncidentEvent(incident.id, "muted", {
          reason: "Flap detection: too many transitions within the window",
          transitions: this.flapTracker.get(input.dedupeKey)?.transitions ?? 0,
        });
        // Still notify with "muted" event type so dispatchers can decide
        try {
          await this.notify({ incident, eventType: "muted", check: input });
        } catch (error) {
          console.error("[monitor] failed to send muted notification", error);
        }
        return;
      }

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

    // Track transition for flap detection
    this.trackTransition(input.dedupeKey);

    if (!this.isMuted(input.dedupeKey)) {
      try {
        await this.notify({ incident: resolved, eventType: "resolved", check: input });
      } catch (error) {
        console.error("[monitor] failed to send resolve notification", error);
      }
    }
  }

  /**
   * Check for warning-severity incidents that have been open too long
   * and escalate them to critical.
   */
  async runEscalationCheck(): Promise<void> {
    const candidates = getEscalationCandidates("default", ESCALATION_AGE_MINUTES);

    for (const incident of candidates) {
      const escalated = escalateIncident(incident.id, "critical");
      insertIncidentEvent(escalated.id, "escalated", {
        previousSeverity: "warning",
        newSeverity: "critical",
        reason: `Warning open for over ${ESCALATION_AGE_MINUTES} minutes — auto-escalated to critical`,
      });

      try {
        // Use a synthetic check input for the notification
        await this.notify({
          incident: escalated,
          eventType: "escalated",
          check: {
            workspaceId: escalated.workspace_id,
            checkType: escalated.check_type,
            targetKey: escalated.target_key,
            status: "failing",
            severity: "critical",
            summary: `Auto-escalated: ${escalated.summary}`,
            evidence: {},
            observedAt: new Date().toISOString(),
            dedupeKey: escalated.dedupe_key,
            title: escalated.title,
          },
        });
      } catch (error) {
        console.error("[monitor] failed to send escalation notification", error);
      }
    }
  }
}
