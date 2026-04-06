import { db } from "../../lib/db.js";
import { getGatewayState } from "../runtime-state.js";
import { DEFAULT_WORKSPACE_ID } from "../workspace.js";
import type { MonitorCheckResultInput } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCheckResult(input: Omit<MonitorCheckResultInput, "workspaceId" | "observedAt">): MonitorCheckResultInput {
  return {
    workspaceId: DEFAULT_WORKSPACE_ID,
    observedAt: new Date().toISOString(),
    ...input,
  };
}

// ---------------------------------------------------------------------------
// 1. gateway.event_flow — are events actually arriving?
// ---------------------------------------------------------------------------

export function runEventFlowCheck(): MonitorCheckResultInput {
  const state = getGatewayState();

  if (state.status !== "connected") {
    // Gateway disconnected — the gateway.connection check handles that.
    return buildCheckResult({
      checkType: "gateway.event_flow",
      targetKey: "gateway",
      status: "unknown",
      severity: "info",
      summary: "Gateway is not connected — event flow check skipped",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:gateway.event_flow:gateway:not_connected`,
      title: "Event flow unknown (gateway disconnected)",
      evidence: { gatewayStatus: state.status, lastEventAt: state.lastEventAt },
    });
  }

  if (!state.lastEventAt) {
    // Connected but no events ever seen.
    return buildCheckResult({
      checkType: "gateway.event_flow",
      targetKey: "gateway",
      status: "unknown",
      severity: "warning",
      summary: "Gateway is connected but no events have been observed yet",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:gateway.event_flow:gateway:no_events_ever`,
      title: "No events observed yet",
      evidence: { gatewayStatus: state.status, lastEventAt: null },
    });
  }

  const silenceMs = Date.now() - Date.parse(state.lastEventAt);
  const silenceMinutes = Math.round(silenceMs / 60_000);

  if (silenceMs > 15 * 60_000) {
    return buildCheckResult({
      checkType: "gateway.event_flow",
      targetKey: "gateway",
      status: "failing",
      severity: "critical",
      summary: `No gateway events in ${silenceMinutes} minutes while connected`,
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:gateway.event_flow:gateway:silent`,
      title: "Gateway event flow is silent",
      evidence: { gatewayStatus: state.status, lastEventAt: state.lastEventAt, silenceMinutes },
    });
  }

  if (silenceMs > 5 * 60_000) {
    return buildCheckResult({
      checkType: "gateway.event_flow",
      targetKey: "gateway",
      status: "degraded",
      severity: "warning",
      summary: `No gateway events in ${silenceMinutes} minutes while connected`,
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:gateway.event_flow:gateway:degraded`,
      title: "Gateway event flow is slow",
      evidence: { gatewayStatus: state.status, lastEventAt: state.lastEventAt, silenceMinutes },
    });
  }

  return buildCheckResult({
    checkType: "gateway.event_flow",
    targetKey: "gateway",
    status: "healthy",
    severity: "info",
    summary: `Events flowing — last event ${silenceMinutes}m ago`,
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:gateway.event_flow:gateway:healthy`,
    title: "Gateway event flow healthy",
    evidence: { gatewayStatus: state.status, lastEventAt: state.lastEventAt, silenceMinutes },
  });
}

// ---------------------------------------------------------------------------
// 2. session.tool_failures — concentrated tool failures in recent runs
// ---------------------------------------------------------------------------

type ToolFailureRow = {
  run_id: string;
  session_key: string;
  source: string;
  failures: number;
  tool_names: string;
};

export function runToolFailuresCheck(): MonitorCheckResultInput {
  const rows = db
    .prepare(
      `
      SELECT
        tc.run_id,
        tc.session_key,
        tc.source,
        COUNT(*) AS failures,
        GROUP_CONCAT(DISTINCT tc.tool_name) AS tool_names
      FROM tool_calls tc
      WHERE tc.success = 0
        AND (julianday('now') - julianday(tc.timestamp)) * 24 * 60 < 5
      GROUP BY tc.run_id
      HAVING failures >= 3
      ORDER BY failures DESC
      LIMIT 5
    `,
    )
    .all() as ToolFailureRow[];

  if (rows.length === 0) {
    return buildCheckResult({
      checkType: "session.tool_failures",
      targetKey: "all-runs",
      status: "healthy",
      severity: "info",
      summary: "No concentrated tool failures in recent runs",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:session.tool_failures:all-runs:healthy`,
      title: "Tool calls healthy",
      evidence: { windowMinutes: 5, runsWithFailures: 0 },
    });
  }

  const worst = rows[0];
  const totalFailures = rows.reduce((sum, row) => sum + row.failures, 0);

  return buildCheckResult({
    checkType: "session.tool_failures",
    targetKey: worst.run_id,
    status: "failing",
    severity: "critical",
    summary: `${totalFailures} tool failures across ${rows.length} run(s) in last 5 min — worst: ${worst.failures} failures (${worst.tool_names})`,
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:session.tool_failures:concentrated:active`,
    title: "Tool calls failing in active sessions",
    evidence: {
      windowMinutes: 5,
      runsWithFailures: rows.length,
      totalFailures,
      runs: rows.map((row) => ({
        runId: row.run_id,
        sessionKey: row.session_key,
        source: row.source,
        failures: row.failures,
        toolNames: row.tool_names,
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// 3. session.dead_runs — runs that completed with zero assistant output
// ---------------------------------------------------------------------------

type DeadRunRow = {
  run_id: string;
  session_key: string;
  source: string;
  duration_ms: number | null;
  started_at: string;
  ended_at: string;
};

export function runDeadRunsCheck(): MonitorCheckResultInput {
  const rows = db
    .prepare(
      `
      SELECT
        r.run_id,
        r.session_key,
        r.source,
        r.duration_ms,
        r.started_at,
        r.ended_at
      FROM agent_runs r
      LEFT JOIN messages m
        ON m.run_id = r.run_id AND m.role = 'assistant'
      WHERE r.status = 'completed'
        AND (julianday('now') - julianday(r.ended_at)) * 24 * 60 < 15
      GROUP BY r.run_id
      HAVING COUNT(m.id) = 0
      ORDER BY r.ended_at DESC
      LIMIT 10
    `,
    )
    .all() as DeadRunRow[];

  if (rows.length === 0) {
    return buildCheckResult({
      checkType: "session.dead_runs",
      targetKey: "all-runs",
      status: "healthy",
      severity: "info",
      summary: "All recent runs produced output",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:session.dead_runs:all-runs:healthy`,
      title: "No dead runs",
      evidence: { windowMinutes: 15, deadRunCount: 0 },
    });
  }

  const cronDeadRuns = rows.filter((r) => r.source === "cron");
  const severity = cronDeadRuns.length > 0 ? "critical" as const : "warning" as const;

  return buildCheckResult({
    checkType: "session.dead_runs",
    targetKey: "all-runs",
    status: "failing",
    severity,
    summary: `${rows.length} run(s) completed with no assistant output in last 15 min${cronDeadRuns.length > 0 ? ` (${cronDeadRuns.length} from cron)` : ""}`,
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:session.dead_runs:all-runs:dead`,
    title: "Dead runs detected — sessions producing nothing",
    evidence: {
      windowMinutes: 15,
      deadRunCount: rows.length,
      cronDeadRunCount: cronDeadRuns.length,
      runs: rows.map((row) => ({
        runId: row.run_id,
        sessionKey: row.session_key,
        source: row.source,
        durationMs: row.duration_ms,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// 4. session.stuck_runs — runs that started but never completed
// ---------------------------------------------------------------------------

type StuckRunRow = {
  run_id: string;
  session_key: string;
  source: string;
  started_at: string;
  elapsed_minutes: number;
};

export function runStuckRunsCheck(): MonitorCheckResultInput {
  const rows = db
    .prepare(
      `
      SELECT
        r.run_id,
        r.session_key,
        r.source,
        r.started_at,
        CAST((julianday('now') - julianday(r.started_at)) * 24 * 60 AS INTEGER) AS elapsed_minutes
      FROM agent_runs r
      WHERE r.status = 'running'
        AND (julianday('now') - julianday(r.started_at)) * 24 * 60 > 30
      ORDER BY r.started_at ASC
      LIMIT 10
    `,
    )
    .all() as StuckRunRow[];

  if (rows.length === 0) {
    return buildCheckResult({
      checkType: "session.stuck_runs",
      targetKey: "all-runs",
      status: "healthy",
      severity: "info",
      summary: "No stuck runs detected",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:session.stuck_runs:all-runs:healthy`,
      title: "No stuck runs",
      evidence: { thresholdMinutes: 30, stuckRunCount: 0 },
    });
  }

  const oldest = rows[0];

  return buildCheckResult({
    checkType: "session.stuck_runs",
    targetKey: "all-runs",
    status: "failing",
    severity: "warning",
    summary: `${rows.length} run(s) stuck in 'running' state — oldest started ${oldest.elapsed_minutes}m ago`,
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:session.stuck_runs:all-runs:stuck`,
    title: "Stuck runs — sessions that never completed",
    evidence: {
      thresholdMinutes: 30,
      stuckRunCount: rows.length,
      runs: rows.map((row) => ({
        runId: row.run_id,
        sessionKey: row.session_key,
        source: row.source,
        startedAt: row.started_at,
        elapsedMinutes: row.elapsed_minutes,
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// 5. session.retry_loops — same tool called excessively in a single run
// ---------------------------------------------------------------------------

type RetryLoopRow = {
  run_id: string;
  session_key: string;
  tool_name: string;
  calls: number;
  failures: number;
};

export function runRetryLoopsCheck(): MonitorCheckResultInput {
  const rows = db
    .prepare(
      `
      SELECT
        tc.run_id,
        tc.session_key,
        tc.tool_name,
        COUNT(*) AS calls,
        SUM(CASE WHEN tc.success = 0 THEN 1 ELSE 0 END) AS failures
      FROM tool_calls tc
      WHERE (julianday('now') - julianday(tc.timestamp)) * 24 * 60 < 10
      GROUP BY tc.run_id, tc.tool_name
      HAVING calls >= 5
      ORDER BY calls DESC
      LIMIT 10
    `,
    )
    .all() as RetryLoopRow[];

  if (rows.length === 0) {
    return buildCheckResult({
      checkType: "session.retry_loops",
      targetKey: "all-runs",
      status: "healthy",
      severity: "info",
      summary: "No retry loops detected in recent runs",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:session.retry_loops:all-runs:healthy`,
      title: "No retry loops",
      evidence: { windowMinutes: 10, loopCount: 0 },
    });
  }

  // Only flag as failing if there are actual failures in the loop
  const loopsWithFailures = rows.filter((r) => r.failures > 0);

  if (loopsWithFailures.length === 0) {
    // High tool usage but no failures — probably legitimate (e.g. reading many files)
    return buildCheckResult({
      checkType: "session.retry_loops",
      targetKey: "all-runs",
      status: "healthy",
      severity: "info",
      summary: "High tool usage detected but no failures — likely legitimate",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:session.retry_loops:all-runs:healthy`,
      title: "No retry loops",
      evidence: { windowMinutes: 10, highUsageCount: rows.length, loopsWithFailures: 0 },
    });
  }

  const worst = loopsWithFailures[0];

  return buildCheckResult({
    checkType: "session.retry_loops",
    targetKey: worst.run_id,
    status: "failing",
    severity: "warning",
    summary: `${loopsWithFailures.length} retry loop(s) detected — ${worst.tool_name} called ${worst.calls}x with ${worst.failures} failures`,
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:session.retry_loops:all-runs:looping`,
    title: "Agent stuck in retry loop",
    evidence: {
      windowMinutes: 10,
      loopCount: loopsWithFailures.length,
      loops: loopsWithFailures.map((row) => ({
        runId: row.run_id,
        sessionKey: row.session_key,
        toolName: row.tool_name,
        calls: row.calls,
        failures: row.failures,
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// 6. session.auth_errors — auth-related failures in tool outputs
// ---------------------------------------------------------------------------

const AUTH_ERROR_PATTERNS = [
  "unauthorized",
  "token expired",
  "token invalid",
  "auth failed",
  "authentication failed",
  "invalid credentials",
  "access denied",
  "invalid api key",
  "invalid_api_key",
  "api key invalid",
];

type AuthErrorRow = {
  id: number;
  run_id: string;
  session_key: string;
  tool_name: string;
  output: string | null;
  timestamp: string;
};

export function runAuthErrorsCheck(): MonitorCheckResultInput {
  // Query recent failed tool calls and check output for auth patterns.
  // Only scan failed calls (success=0) to avoid false positives from
  // CLI help text or successful responses that mention auth keywords.
  const rows = db
    .prepare(
      `
      SELECT
        tc.id,
        tc.run_id,
        tc.session_key,
        tc.tool_name,
        tc.output,
        tc.timestamp
      FROM tool_calls tc
      WHERE (julianday('now') - julianday(tc.timestamp)) * 24 * 60 < 10
        AND tc.output IS NOT NULL
        AND tc.success = 0
      ORDER BY tc.timestamp DESC
      LIMIT 200
    `,
    )
    .all() as AuthErrorRow[];

  const authErrors: Array<{
    runId: string;
    sessionKey: string;
    toolName: string;
    matchedPattern: string;
    snippet: string;
    timestamp: string;
  }> = [];

  for (const row of rows) {
    if (!row.output) continue;
    const outputLower = row.output.toLowerCase();
    const matched = AUTH_ERROR_PATTERNS.find((pattern) => outputLower.includes(pattern));
    if (matched) {
      authErrors.push({
        runId: row.run_id,
        sessionKey: row.session_key,
        toolName: row.tool_name,
        matchedPattern: matched,
        snippet: row.output.slice(0, 300),
        timestamp: row.timestamp,
      });
    }
  }

  if (authErrors.length === 0) {
    return buildCheckResult({
      checkType: "session.auth_errors",
      targetKey: "all-runs",
      status: "healthy",
      severity: "info",
      summary: "No auth-related errors in recent tool calls",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:session.auth_errors:all-runs:healthy`,
      title: "No auth errors",
      evidence: { windowMinutes: 10, scannedCalls: rows.length, authErrorCount: 0 },
    });
  }

  // Dedupe by run — report unique runs with auth errors
  const uniqueRuns = new Set(authErrors.map((e) => e.runId));

  return buildCheckResult({
    checkType: "session.auth_errors",
    targetKey: "all-runs",
    status: "failing",
    severity: "critical",
    summary: `${authErrors.length} auth error(s) across ${uniqueRuns.size} run(s) in last 10 min — ${authErrors[0].toolName}: "${authErrors[0].matchedPattern}"`,
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:session.auth_errors:all-runs:auth_failing`,
    title: "Auth errors detected in tool calls",
    evidence: {
      windowMinutes: 10,
      scannedCalls: rows.length,
      authErrorCount: authErrors.length,
      uniqueRuns: uniqueRuns.size,
      errors: authErrors.slice(0, 10),
    },
  });
}

// ---------------------------------------------------------------------------
// 7. session.tool_errors — application-level errors in tool result payloads
// ---------------------------------------------------------------------------

const TOOL_ERROR_PATTERNS = [
  '"status":"error"',
  '"status": "error"',
  "timed out",
  "connection refused",
  "econnrefused",
  "etimedout",
  "browser is currently unavailable",
  "command failed",
  "process exited with code",
];

type ToolErrorRow = {
  id: number;
  run_id: string;
  session_key: string;
  tool_name: string;
  output: string | null;
  timestamp: string;
};

export function runToolErrorsCheck(): MonitorCheckResultInput {
  const rows = db
    .prepare(
      `
      SELECT
        tc.id,
        tc.run_id,
        tc.session_key,
        tc.tool_name,
        tc.output,
        tc.timestamp
      FROM tool_calls tc
      WHERE (julianday('now') - julianday(tc.timestamp)) * 24 * 60 < 10
        AND tc.output IS NOT NULL
        AND tc.success != 0
      ORDER BY tc.timestamp DESC
      LIMIT 200
    `,
    )
    .all() as ToolErrorRow[];

  const toolErrors: Array<{
    runId: string;
    sessionKey: string;
    toolName: string;
    matchedPattern: string;
    snippet: string;
    timestamp: string;
  }> = [];

  for (const row of rows) {
    if (!row.output) continue;
    const outputLower = row.output.toLowerCase();
    const matched = TOOL_ERROR_PATTERNS.find((pattern) => outputLower.includes(pattern));
    if (matched) {
      toolErrors.push({
        runId: row.run_id,
        sessionKey: row.session_key,
        toolName: row.tool_name,
        matchedPattern: matched,
        snippet: row.output.slice(0, 300),
        timestamp: row.timestamp,
      });
    }
  }

  if (toolErrors.length === 0) {
    return buildCheckResult({
      checkType: "session.tool_errors",
      targetKey: "all-runs",
      status: "healthy",
      severity: "info",
      summary: "No application-level tool errors in recent calls",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:session.tool_errors:all-runs:healthy`,
      title: "No tool errors",
      evidence: { windowMinutes: 10, scannedCalls: rows.length, toolErrorCount: 0 },
    });
  }

  const uniqueRuns = new Set(toolErrors.map((e) => e.runId));

  return buildCheckResult({
    checkType: "session.tool_errors",
    targetKey: "all-runs",
    status: "failing",
    severity: "warning",
    summary: `${toolErrors.length} tool error(s) across ${uniqueRuns.size} run(s) in last 10 min — ${toolErrors[0].toolName}: "${toolErrors[0].matchedPattern}"`,
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:session.tool_errors:all-runs:errors_detected`,
    title: "Application-level errors in tool call results",
    evidence: {
      windowMinutes: 10,
      scannedCalls: rows.length,
      toolErrorCount: toolErrors.length,
      uniqueRuns: uniqueRuns.size,
      errors: toolErrors.slice(0, 10),
    },
  });
}
