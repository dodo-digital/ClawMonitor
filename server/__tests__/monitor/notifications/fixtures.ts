import type { NotificationPayload } from "../../../monitor/notifications/types.js";
import type { IncidentRecord, MonitorCheckResultInput } from "../../../monitor/types.js";

export function makePayload(overrides?: { eventType?: "opened" | "resolved" }): NotificationPayload {
  const incident: IncidentRecord = {
    id: 1,
    workspace_id: "default",
    dedupe_key: "default:system.disk:/:critical",
    check_type: "system.disk",
    target_key: "/",
    status: "open",
    severity: "critical",
    title: "Disk usage critical",
    summary: "Disk usage is at 98%",
    opened_at: "2026-04-02T00:00:00.000Z",
    acknowledged_at: null,
    resolved_at: null,
    last_seen_at: "2026-04-02T00:01:00.000Z",
    acknowledged_by_user_id: null,
    resolution_note: null,
  };

  const check: MonitorCheckResultInput = {
    workspaceId: "default",
    checkType: "system.disk",
    targetKey: "/",
    status: "failing",
    severity: "critical",
    summary: "Disk usage is at 98%",
    evidence: { usePercent: 98 },
    observedAt: "2026-04-02T00:00:00.000Z",
    dedupeKey: "default:system.disk:/:critical",
    title: "Disk usage critical",
  };

  return {
    incident,
    eventType: overrides?.eventType ?? "opened",
    check,
  };
}
