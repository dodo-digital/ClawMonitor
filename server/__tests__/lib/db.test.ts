import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, initializeDatabase } from "../../lib/db.js";

describe("db initialization and statements", () => {
  let rootDir: string;
  let dbPath: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-db-"));
    dbPath = path.join(rootDir, "dashboard.sqlite");
    initializeDatabase(dbPath);
  });

  afterEach(async () => {
    db.close();
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  it("creates all tables", async () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(tables.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "agent_runs",
        "check_results",
        "events",
        "incident_events",
        "incidents",
        "messages",
        "sessions",
        "skill_triggers",
        "tool_calls",
      ]),
    );
  });

  it("creates all indexes", () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(indexes.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "idx_sessions_agent",
        "idx_sessions_channel",
        "idx_sessions_source",
        "idx_sessions_updated",
        "idx_runs_session",
        "idx_runs_agent",
        "idx_runs_started",
        "idx_runs_channel",
        "idx_messages_session",
        "idx_messages_run",
        "idx_messages_role",
        "idx_messages_timestamp",
        "idx_messages_session_entry_id",
        "idx_tools_run",
        "idx_tools_name",
        "idx_tools_timestamp",
        "idx_tool_calls_session_tool_call_id",
        "idx_skills_name",
        "idx_skills_timestamp",
        "idx_events_timestamp",
        "idx_events_type",
        "idx_events_session",
        "idx_check_results_lookup",
        "idx_check_results_dedupe",
        "idx_incidents_workspace_status",
        "idx_incidents_dedupe",
        "idx_incidents_active_dedupe",
        "idx_incident_events_incident",
      ]),
    );
  });

  it("supports the prepared statement lifecycle", async () => {
    const { stmts } = await import("../../lib/db.js");

    stmts.upsertSession.run({
      session_key: "agent:direct:main",
      agent_id: "direct",
      channel: "main",
      channel_name: "Main Session",
      source: "control-ui",
      runtime_type: "native",
    });

    stmts.upsertSession.run({
      session_key: "agent:direct:main",
      agent_id: "direct",
      channel: "main",
      channel_name: "Updated Session",
      source: "telegram",
      runtime_type: "native",
    });

    stmts.insertRun.run({
      run_id: "run-1",
      session_key: "agent:direct:main",
      agent_id: "direct",
      channel: "main",
      channel_name: "Main Session",
      source: "control-ui",
      model: "gpt-test",
      started_at: "2026-04-01T00:00:00.000Z",
    });

    stmts.endRun.run({
      run_id: "run-1",
      ended_at: "2026-04-01T00:00:05.000Z",
      duration_ms: 5000,
    });

    stmts.insertMessage.run({
      entry_id: "msg-user",
      run_id: "run-1",
      session_key: "agent:direct:main",
      agent_id: "direct",
      role: "user",
      content: "hello",
      channel: "main",
      channel_name: "Main Session",
      source: "control-ui",
      tokens: 10,
      cost_total: null,
      timestamp: "2026-04-01T00:00:01.000Z",
    });

    stmts.insertMessage.run({
      entry_id: "msg-assistant",
      run_id: "run-1",
      session_key: "agent:direct:main",
      agent_id: "direct",
      role: "assistant",
      content: "hi",
      channel: "main",
      channel_name: "Main Session",
      source: "control-ui",
      tokens: 20,
      cost_total: 0.42,
      timestamp: "2026-04-01T00:00:02.000Z",
    });

    stmts.insertMessage.run({
      entry_id: "msg-tool",
      run_id: "run-1",
      session_key: "agent:direct:main",
      agent_id: "direct",
      role: "toolResult",
      content: "{\"ok\":true}",
      channel: "main",
      channel_name: "Main Session",
      source: "control-ui",
      tokens: null,
      cost_total: null,
      timestamp: "2026-04-01T00:00:03.000Z",
    });

    stmts.insertToolCall.run({
      tool_call_id: "tool-1",
      run_id: "run-1",
      session_key: "agent:direct:main",
      agent_id: "direct",
      tool_name: "memory_search",
      input: "{\"query\":\"harrison\"}",
      output: null,
      channel: "main",
      source: "control-ui",
      duration_ms: null,
      success: null,
      timestamp: "2026-04-01T00:00:02.500Z",
    });

    stmts.insertToolCall.run({
      tool_call_id: null,
      run_id: "run-1",
      session_key: "agent:direct:main",
      agent_id: "direct",
      tool_name: "exec",
      input: "{\"cmd\":\"echo hi\"}",
      output: "hi",
      channel: "main",
      source: "control-ui",
      duration_ms: 50,
      success: 1,
      timestamp: "2026-04-01T00:00:02.750Z",
    });

    stmts.updateToolCallResult.run({
      session_key: "agent:direct:main",
      tool_call_id: "tool-1",
      output: "[{\"score\":0.8}]",
      success: 1,
    });

    stmts.insertSkillTrigger.run({
      skill_name: "agent-browser",
      agent_id: "direct",
      session_key: "agent:direct:main",
      channel: "main",
      channel_name: "Main Session",
      source: "control-ui",
      timestamp: "2026-04-01T00:00:04.000Z",
    });

    stmts.insertEvent.run({
      type: "event",
      event: "agent",
      agent_id: "direct",
      run_id: "run-1",
      session_key: "agent:direct:main",
      channel: "main",
      channel_name: "Main Session",
      source: "control-ui",
      payload: "{\"event\":\"agent\"}",
      timestamp: "2026-04-01T00:00:04.500Z",
    });

    stmts.incrementSessionMetrics.run({
      session_key: "agent:direct:main",
      message_increment: 3,
      token_increment: 30,
    });

    const session = db.prepare("SELECT * FROM sessions WHERE session_key = ?").get("agent:direct:main") as {
      source: string;
      channel_name: string;
      message_count: number;
      total_tokens: number;
    };
    const run = db.prepare("SELECT * FROM agent_runs WHERE run_id = ?").get("run-1") as {
      status: string;
      duration_ms: number;
    };
    const messages = db.prepare("SELECT role, cost_total FROM messages ORDER BY timestamp").all() as Array<{
      role: string;
      cost_total: number | null;
    }>;
    const toolCalls = db.prepare("SELECT tool_call_id, output, success FROM tool_calls ORDER BY id").all() as Array<{
      tool_call_id: string | null;
      output: string | null;
      success: number | null;
    }>;
    const skillTriggers = db.prepare("SELECT COUNT(*) as count FROM skill_triggers").get() as { count: number };
    const events = db.prepare("SELECT COUNT(*) as count FROM events").get() as { count: number };

    expect(session).toMatchObject({
      source: "telegram",
      channel_name: "Updated Session",
      message_count: 3,
      total_tokens: 30,
    });
    expect(run).toMatchObject({
      status: "completed",
      duration_ms: 5000,
    });
    expect(messages).toEqual([
      { role: "user", cost_total: null },
      { role: "assistant", cost_total: 0.42 },
      { role: "toolResult", cost_total: null },
    ]);
    expect(toolCalls).toEqual([
      { tool_call_id: "tool-1", output: "[{\"score\":0.8}]", success: 1 },
      { tool_call_id: null, output: "hi", success: 1 },
    ]);
    expect(skillTriggers.count).toBe(1);
    expect(events.count).toBe(1);
  });

  it("cleans only events older than seven days", async () => {
    const { stmts } = await import("../../lib/db.js");

    stmts.insertEvent.run({
      type: "event",
      event: "old",
      agent_id: "direct",
      run_id: "run-old",
      session_key: "agent:direct:main",
      channel: "main",
      channel_name: "Main Session",
      source: "control-ui",
      payload: "{}",
      timestamp: "2000-01-01T00:00:00.000Z",
    });
    stmts.insertEvent.run({
      type: "event",
      event: "new",
      agent_id: "direct",
      run_id: "run-new",
      session_key: "agent:direct:main",
      channel: "main",
      channel_name: "Main Session",
      source: "control-ui",
      payload: "{}",
      timestamp: "2999-01-01T00:00:00.000Z",
    });

    stmts.cleanOldEvents.run();

    const events = db.prepare("SELECT event FROM events ORDER BY event").all() as Array<{ event: string }>;
    expect(events).toEqual([{ event: "new" }]);
  });

  it("deduplicates messages and tool calls when unique ids are present", async () => {
    const { stmts } = await import("../../lib/db.js");

    stmts.upsertSession.run({
      session_key: "agent:direct:main",
      agent_id: "direct",
      channel: "main",
      channel_name: "Main Session",
      source: "control-ui",
      runtime_type: "native",
    });

    stmts.insertMessage.run({
      entry_id: "dup-message",
      run_id: null,
      session_key: "agent:direct:main",
      agent_id: "direct",
      role: "assistant",
      content: "same",
      channel: "main",
      channel_name: "Main Session",
      source: "control-ui",
      tokens: 1,
      cost_total: null,
      timestamp: "2026-04-01T00:00:00.000Z",
    });
    stmts.insertMessage.run({
      entry_id: "dup-message",
      run_id: null,
      session_key: "agent:direct:main",
      agent_id: "direct",
      role: "assistant",
      content: "same",
      channel: "main",
      channel_name: "Main Session",
      source: "control-ui",
      tokens: 1,
      cost_total: null,
      timestamp: "2026-04-01T00:00:00.000Z",
    });

    stmts.insertToolCall.run({
      tool_call_id: "dup-tool",
      run_id: null,
      session_key: "agent:direct:main",
      agent_id: "direct",
      tool_name: "memory_search",
      input: "{}",
      output: null,
      channel: "main",
      source: "control-ui",
      duration_ms: null,
      success: null,
      timestamp: "2026-04-01T00:00:01.000Z",
    });
    stmts.insertToolCall.run({
      tool_call_id: "dup-tool",
      run_id: null,
      session_key: "agent:direct:main",
      agent_id: "direct",
      tool_name: "memory_search",
      input: "{}",
      output: null,
      channel: "main",
      source: "control-ui",
      duration_ms: null,
      success: null,
      timestamp: "2026-04-01T00:00:01.000Z",
    });

    const messageCount = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
    const toolCount = db.prepare("SELECT COUNT(*) as count FROM tool_calls").get() as { count: number };

    expect(messageCount.count).toBe(1);
    expect(toolCount.count).toBe(1);
  });
});
