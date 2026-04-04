import { db } from "../../lib/db.js";
import type {
  CheckResultRecord,
  IncidentEventRecord,
  IncidentRecord,
  MonitorCheckResultInput,
} from "../types.js";

type RawIncidentRow = IncidentRecord;
type RawIncidentEventRow = IncidentEventRecord;

function parseJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function insertCheckResult(input: MonitorCheckResultInput): CheckResultRecord {
  const info = db.prepare(
    `
      INSERT INTO check_results (
        workspace_id,
        check_type,
        target_key,
        status,
        severity,
        summary,
        evidence_json,
        dedupe_key,
        observed_at
      ) VALUES (
        @workspace_id,
        @check_type,
        @target_key,
        @status,
        @severity,
        @summary,
        @evidence_json,
        @dedupe_key,
        @observed_at
      )
    `,
  ).run({
    workspace_id: input.workspaceId,
    check_type: input.checkType,
    target_key: input.targetKey,
    status: input.status,
    severity: input.severity,
    summary: input.summary,
    evidence_json: JSON.stringify(input.evidence),
    dedupe_key: input.dedupeKey,
    observed_at: input.observedAt,
  });

  const row = db.prepare("SELECT * FROM check_results WHERE id = ?").get(info.lastInsertRowid) as CheckResultRecord;
  return row;
}

export function getActiveIncidentByDedupeKey(workspaceId: string, dedupeKey: string): IncidentRecord | undefined {
  return db.prepare(
    `
      SELECT *
      FROM incidents
      WHERE workspace_id = ? AND dedupe_key = ? AND status != 'resolved'
      ORDER BY opened_at DESC
      LIMIT 1
    `,
  ).get(workspaceId, dedupeKey) as IncidentRecord | undefined;
}

export function getRecentlyResolvedByDedupeKey(
  workspaceId: string,
  dedupeKey: string,
  cooldownMinutes: number,
): IncidentRecord | undefined {
  return db.prepare(
    `
      SELECT *
      FROM incidents
      WHERE workspace_id = ? AND dedupe_key = ? AND status = 'resolved'
        AND (julianday('now') - julianday(resolved_at)) * 24 * 60 < ?
      ORDER BY resolved_at DESC
      LIMIT 1
    `,
  ).get(workspaceId, dedupeKey, cooldownMinutes) as IncidentRecord | undefined;
}

export function getActiveIncidentByCheckTarget(
  workspaceId: string,
  checkType: string,
  targetKey: string,
): IncidentRecord | undefined {
  return db.prepare(
    `
      SELECT *
      FROM incidents
      WHERE workspace_id = ? AND check_type = ? AND target_key = ? AND status != 'resolved'
      ORDER BY opened_at DESC
      LIMIT 1
    `,
  ).get(workspaceId, checkType, targetKey) as IncidentRecord | undefined;
}

export function openIncident(input: MonitorCheckResultInput): IncidentRecord {
  const info = db.prepare(
    `
      INSERT INTO incidents (
        workspace_id,
        dedupe_key,
        check_type,
        target_key,
        status,
        severity,
        title,
        summary,
        opened_at,
        last_seen_at
      ) VALUES (
        @workspace_id,
        @dedupe_key,
        @check_type,
        @target_key,
        'open',
        @severity,
        @title,
        @summary,
        @opened_at,
        @last_seen_at
      )
    `,
  ).run({
    workspace_id: input.workspaceId,
    dedupe_key: input.dedupeKey,
    check_type: input.checkType,
    target_key: input.targetKey,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    opened_at: input.observedAt,
    last_seen_at: input.observedAt,
  });

  return db.prepare("SELECT * FROM incidents WHERE id = ?").get(info.lastInsertRowid) as IncidentRecord;
}

export function updateIncidentSeen(incidentId: number, input: MonitorCheckResultInput): IncidentRecord {
  db.prepare(
    `
      UPDATE incidents
      SET severity = @severity,
          title = @title,
          summary = @summary,
          last_seen_at = @last_seen_at
      WHERE id = @id
    `,
  ).run({
    id: incidentId,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    last_seen_at: input.observedAt,
  });

  return db.prepare("SELECT * FROM incidents WHERE id = ?").get(incidentId) as IncidentRecord;
}

export function resolveIncident(incidentId: number, observedAt: string, resolutionNote: string): IncidentRecord {
  db.prepare(
    `
      UPDATE incidents
      SET status = 'resolved',
          resolved_at = @resolved_at,
          last_seen_at = @last_seen_at,
          resolution_note = @resolution_note
      WHERE id = @id
    `,
  ).run({
    id: incidentId,
    resolved_at: observedAt,
    last_seen_at: observedAt,
    resolution_note: resolutionNote,
  });

  return db.prepare("SELECT * FROM incidents WHERE id = ?").get(incidentId) as IncidentRecord;
}

export function insertIncidentEvent(
  incidentId: number,
  eventType: string,
  payload: Record<string, unknown>,
  actorUserId: string | null = null,
): IncidentEventRecord {
  const info = db.prepare(
    `
      INSERT INTO incident_events (incident_id, event_type, payload_json, actor_user_id)
      VALUES (@incident_id, @event_type, @payload_json, @actor_user_id)
    `,
  ).run({
    incident_id: incidentId,
    event_type: eventType,
    payload_json: JSON.stringify(payload),
    actor_user_id: actorUserId,
  });

  return db.prepare("SELECT * FROM incident_events WHERE id = ?").get(info.lastInsertRowid) as IncidentEventRecord;
}

export function listIncidents(workspaceId: string): Array<IncidentRecord & { event_count: number }> {
  return db.prepare(
    `
      SELECT incidents.*, COUNT(incident_events.id) AS event_count
      FROM incidents
      LEFT JOIN incident_events ON incident_events.incident_id = incidents.id
      WHERE incidents.workspace_id = ?
      GROUP BY incidents.id
      ORDER BY
        CASE incidents.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
        CASE incidents.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        incidents.last_seen_at DESC
    `,
  ).all(workspaceId) as Array<IncidentRecord & { event_count: number }>;
}

export function getIncidentDetail(workspaceId: string, incidentId: number): {
  incident: IncidentRecord;
  events: Array<IncidentEventRecord & { payload: Record<string, unknown> }>;
  recentResults: Array<CheckResultRecord & { evidence: Record<string, unknown> }>;
} | null {
  const incident = db.prepare(
    `
      SELECT *
      FROM incidents
      WHERE workspace_id = ? AND id = ?
    `,
  ).get(workspaceId, incidentId) as RawIncidentRow | undefined;

  if (!incident) {
    return null;
  }

  const events = db.prepare(
    `
      SELECT *
      FROM incident_events
      WHERE incident_id = ?
      ORDER BY created_at DESC, id DESC
    `,
  ).all(incidentId) as RawIncidentEventRow[];

  const recentResults = db.prepare(
    `
      SELECT *
      FROM check_results
      WHERE workspace_id = ? AND dedupe_key = ?
      ORDER BY observed_at DESC, id DESC
      LIMIT 20
    `,
  ).all(workspaceId, incident.dedupe_key) as CheckResultRecord[];

  return {
    incident,
    events: events.map((event) => ({ ...event, payload: parseJson(event.payload_json) })),
    recentResults: recentResults.map((result) => ({ ...result, evidence: parseJson(result.evidence_json) })),
  };
}
