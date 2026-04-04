import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, initializeDatabase, stmts } from "../../lib/db.js";
import {
  recordGatewayConnected,
  recordGatewayEventSeen,
  resetGatewayState,
} from "../../monitor/runtime-state.js";
import {
  runAuthErrorsCheck,
  runDeadRunsCheck,
  runEventFlowCheck,
  runRetryLoopsCheck,
  runStuckRunsCheck,
  runToolFailuresCheck,
} from "../../monitor/checks/session.js";

// Helper to insert a run
function insertRun(params: {
  runId: string;
  sessionKey: string;
  source?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
}): void {
  stmts.upsertSession.run({
    session_key: params.sessionKey,
    agent_id: "direct",
    channel: "cron",
    channel_name: "test",
    source: params.source ?? "cron",
    runtime_type: "native",
  });

  stmts.insertRun.run({
    run_id: params.runId,
    session_key: params.sessionKey,
    agent_id: "direct",
    channel: "cron",
    channel_name: "test",
    source: params.source ?? "cron",
    model: "claude-sonnet-4-6",
    started_at: params.startedAt,
  });

  if (params.endedAt) {
    stmts.endRun.run({
      run_id: params.runId,
      ended_at: params.endedAt,
      duration_ms: params.durationMs ?? null,
    });
  }
}

// Helper to insert a tool call
function insertToolCall(params: {
  runId: string;
  sessionKey: string;
  toolName: string;
  success: number;
  output?: string;
}): void {
  stmts.insertToolCall.run({
    tool_call_id: `tc-${Math.random().toString(36).slice(2, 10)}`,
    run_id: params.runId,
    session_key: params.sessionKey,
    agent_id: "direct",
    tool_name: params.toolName,
    input: JSON.stringify({ test: true }),
    output: params.output ?? (params.success ? "ok" : "error"),
    channel: "cron",
    source: "cron",
    duration_ms: 100,
    success: params.success,
    timestamp: new Date().toISOString(),
  });
}

// Helper to insert a message
function insertMessage(params: {
  runId: string;
  sessionKey: string;
  role: string;
  content: string;
}): void {
  stmts.insertMessage.run({
    entry_id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    run_id: params.runId,
    session_key: params.sessionKey,
    agent_id: "direct",
    role: params.role,
    content: params.content,
    channel: "cron",
    channel_name: "test",
    source: "cron",
    tokens: 100,
    cost_total: 0.001,
    timestamp: new Date().toISOString(),
  });
}

describe("session checks", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-checks-"));
    initializeDatabase(path.join(rootDir, "dashboard.sqlite"));
  });

  afterEach(async () => {
    db.close();
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // gateway.event_flow
  // -----------------------------------------------------------------------

  it("event flow: reports healthy when events are recent", () => {
    resetGatewayState();
    recordGatewayConnected();
    recordGatewayEventSeen();

    const result = runEventFlowCheck();
    expect(result).toMatchObject({
      checkType: "gateway.event_flow",
      status: "healthy",
    });
  });

  it("event flow: reports unknown when gateway is disconnected", () => {
    resetGatewayState();

    const result = runEventFlowCheck();
    expect(result).toMatchObject({
      checkType: "gateway.event_flow",
      status: "unknown",
    });
  });

  // -----------------------------------------------------------------------
  // session.tool_failures
  // -----------------------------------------------------------------------

  it("tool failures: reports healthy when no failures", () => {
    const result = runToolFailuresCheck();
    expect(result).toMatchObject({
      checkType: "session.tool_failures",
      status: "healthy",
    });
  });

  it("tool failures: detects concentrated failures in a run", () => {
    const sessionKey = "agent:direct:cron:test-fail";
    const runId = "run-fail-1";

    insertRun({ runId, sessionKey, startedAt: new Date().toISOString() });

    for (let i = 0; i < 5; i++) {
      insertToolCall({
        runId,
        sessionKey,
        toolName: "Bash",
        success: 0,
        output: "command not found",
      });
    }

    const result = runToolFailuresCheck();
    expect(result).toMatchObject({
      checkType: "session.tool_failures",
      status: "failing",
      severity: "critical",
    });
    expect((result.evidence as { totalFailures: number }).totalFailures).toBeGreaterThanOrEqual(5);
  });

  // -----------------------------------------------------------------------
  // session.dead_runs
  // -----------------------------------------------------------------------

  it("dead runs: reports healthy when runs have output", () => {
    const sessionKey = "agent:direct:cron:test-alive";
    const runId = "run-alive-1";
    const now = new Date();

    insertRun({
      runId,
      sessionKey,
      startedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
      endedAt: now.toISOString(),
      durationMs: 300_000,
    });

    insertMessage({
      runId,
      sessionKey,
      role: "assistant",
      content: "I completed the task.",
    });

    const result = runDeadRunsCheck();
    expect(result).toMatchObject({
      checkType: "session.dead_runs",
      status: "healthy",
    });
  });

  it("dead runs: detects runs with no assistant output", () => {
    const sessionKey = "agent:direct:cron:test-dead";
    const runId = "run-dead-1";
    const now = new Date();

    insertRun({
      runId,
      sessionKey,
      startedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
      endedAt: now.toISOString(),
      durationMs: 300_000,
    });

    // No messages inserted — dead run

    const result = runDeadRunsCheck();
    expect(result).toMatchObject({
      checkType: "session.dead_runs",
      status: "failing",
    });
    expect((result.evidence as { deadRunCount: number }).deadRunCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // session.stuck_runs
  // -----------------------------------------------------------------------

  it("stuck runs: reports healthy when no stuck runs", () => {
    const result = runStuckRunsCheck();
    expect(result).toMatchObject({
      checkType: "session.stuck_runs",
      status: "healthy",
    });
  });

  it("stuck runs: detects runs stuck in running state", () => {
    const sessionKey = "agent:direct:cron:test-stuck";
    const runId = "run-stuck-1";
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();

    insertRun({ runId, sessionKey, startedAt: longAgo });
    // No endedAt — still "running"

    const result = runStuckRunsCheck();
    expect(result).toMatchObject({
      checkType: "session.stuck_runs",
      status: "failing",
      severity: "warning",
    });
    expect((result.evidence as { stuckRunCount: number }).stuckRunCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // session.retry_loops
  // -----------------------------------------------------------------------

  it("retry loops: reports healthy when no loops", () => {
    const result = runRetryLoopsCheck();
    expect(result).toMatchObject({
      checkType: "session.retry_loops",
      status: "healthy",
    });
  });

  it("retry loops: detects same tool failing repeatedly", () => {
    const sessionKey = "agent:direct:cron:test-loop";
    const runId = "run-loop-1";

    insertRun({ runId, sessionKey, startedAt: new Date().toISOString() });

    for (let i = 0; i < 7; i++) {
      insertToolCall({
        runId,
        sessionKey,
        toolName: "Read",
        success: 0,
        output: "file not found: /memory/missing.md",
      });
    }

    const result = runRetryLoopsCheck();
    expect(result).toMatchObject({
      checkType: "session.retry_loops",
      status: "failing",
      severity: "warning",
    });
  });

  it("retry loops: does not flag high usage without failures", () => {
    const sessionKey = "agent:direct:cron:test-busy";
    const runId = "run-busy-1";

    insertRun({ runId, sessionKey, startedAt: new Date().toISOString() });

    for (let i = 0; i < 10; i++) {
      insertToolCall({
        runId,
        sessionKey,
        toolName: "Read",
        success: 1,
        output: "file content here",
      });
    }

    const result = runRetryLoopsCheck();
    expect(result).toMatchObject({
      checkType: "session.retry_loops",
      status: "healthy",
    });
  });

  // -----------------------------------------------------------------------
  // session.auth_errors
  // -----------------------------------------------------------------------

  it("auth errors: reports healthy when no auth errors", () => {
    const sessionKey = "agent:direct:cron:test-ok";
    const runId = "run-ok-1";

    insertRun({ runId, sessionKey, startedAt: new Date().toISOString() });
    insertToolCall({
      runId,
      sessionKey,
      toolName: "Bash",
      success: 1,
      output: "build completed",
    });

    const result = runAuthErrorsCheck();
    expect(result).toMatchObject({
      checkType: "session.auth_errors",
      status: "healthy",
    });
  });

  it("auth errors: detects 401/unauthorized in tool output", () => {
    const sessionKey = "agent:direct:cron:test-auth";
    const runId = "run-auth-fail-1";

    insertRun({ runId, sessionKey, startedAt: new Date().toISOString() });
    insertToolCall({
      runId,
      sessionKey,
      toolName: "Bash",
      success: 0,
      output: "HTTP 401 Unauthorized: invalid api key",
    });

    const result = runAuthErrorsCheck();
    expect(result).toMatchObject({
      checkType: "session.auth_errors",
      status: "failing",
      severity: "critical",
    });
    expect((result.evidence as { authErrorCount: number }).authErrorCount).toBeGreaterThanOrEqual(1);
  });

  it("auth errors: detects token expired in tool output", () => {
    const sessionKey = "agent:direct:cron:test-auth2";
    const runId = "run-auth-fail-2";

    insertRun({ runId, sessionKey, startedAt: new Date().toISOString() });
    insertToolCall({
      runId,
      sessionKey,
      toolName: "WebFetch",
      success: 1,
      output: JSON.stringify({ error: "token expired", message: "Please refresh your access token" }),
    });

    const result = runAuthErrorsCheck();
    expect(result).toMatchObject({
      checkType: "session.auth_errors",
      status: "failing",
      severity: "critical",
    });
  });
});
