export type MonitorStatus = "healthy" | "degraded" | "failing" | "unknown";
export type MonitorSeverity = "info" | "warning" | "critical";

export type CheckResultRecord = {
  id: number;
  workspace_id: string;
  check_type: string;
  target_key: string;
  status: MonitorStatus;
  severity: MonitorSeverity;
  summary: string;
  evidence_json: string;
  dedupe_key: string;
  observed_at: string;
};

export type IncidentStatus = "open" | "acknowledged" | "resolved";

export type IncidentRecord = {
  id: number;
  workspace_id: string;
  dedupe_key: string;
  check_type: string;
  target_key: string;
  status: IncidentStatus;
  severity: MonitorSeverity;
  title: string;
  summary: string;
  opened_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  last_seen_at: string;
  acknowledged_by_user_id: string | null;
  resolution_note: string | null;
};

export type IncidentEventRecord = {
  id: number;
  incident_id: number;
  event_type: string;
  payload_json: string;
  created_at: string;
  actor_user_id: string | null;
};

export type MonitorCheckResultInput = {
  workspaceId: string;
  checkType: string;
  targetKey: string;
  status: MonitorStatus;
  severity: MonitorSeverity;
  summary: string;
  evidence: Record<string, unknown>;
  observedAt: string;
  dedupeKey: string;
  title: string;
};
