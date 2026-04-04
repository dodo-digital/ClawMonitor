import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, initializeDatabase } from "../../lib/db.js";
import { ingestGatewayEvent, parseSessionKey } from "../../lib/event-ingester.js";

describe("parseSessionKey", () => {
  it("parses a direct main session", () => {
    expect(parseSessionKey("agent:direct:main")).toMatchObject({
      agentId: "direct",
      channel: "main",
      source: "control-ui",
      runtimeType: "native",
    });
  });

  it("parses a telegram session", () => {
    expect(parseSessionKey("agent:direct:telegram:group:-1003691004254:topic:1")).toMatchObject({
      agentId: "direct",
      channel: "telegram",
      source: "telegram",
      runtimeType: "native",
      channelName: "telegram:group:-1003691004254:topic:1",
    });
  });

  it("parses a webchat session", () => {
    expect(parseSessionKey("agent:direct:webchat:abc123")).toMatchObject({
      agentId: "direct",
      channel: "webchat",
      source: "control-ui",
      runtimeType: "native",
      channelName: "webchat:abc123",
    });
  });

  it("parses an acp binding session", () => {
    expect(parseSessionKey("agent:acp-claude:binding:telegram:group:-1003691004254:topic:4")).toMatchObject({
      agentId: "acp-claude",
      channel: "telegram",
      source: "telegram",
      runtimeType: "acp",
    });
  });

  it("parses a cron session", () => {
    expect(parseSessionKey("cron:jobname:isolated")).toMatchObject({
      agentId: "cron",
      channel: "cron",
      source: "cron",
      runtimeType: "native",
      channelName: "cron:jobname:isolated",
    });
  });

  it("parses a hook session", () => {
    expect(parseSessionKey("hook:github:repo:issue:123")).toMatchObject({
      agentId: "hook",
      channel: "hook",
      source: "hook:github",
      runtimeType: "native",
      channelName: "hook:github:repo:issue:123",
    });
  });

  it("falls back for an empty string", () => {
    expect(parseSessionKey("")).toEqual({
      agentId: "unknown",
      channel: "unknown",
      channelName: "",
      source: "unknown",
      runtimeType: "native",
    });
  });

  it("falls back for a partial agent session key", () => {
    expect(parseSessionKey("agent:direct")).toEqual({
      agentId: "unknown",
      channel: "unknown",
      channelName: "agent:direct",
      source: "unknown",
      runtimeType: "native",
    });
  });

  it("falls back for an unknown format", () => {
    expect(parseSessionKey("weird:format")).toEqual({
      agentId: "unknown",
      channel: "unknown",
      channelName: "weird:format",
      source: "unknown",
      runtimeType: "native",
    });
  });
});

describe("ingestGatewayEvent", () => {
  let rootDir: string;
  let dbPath: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-event-ingester-"));
    dbPath = path.join(rootDir, "dashboard.sqlite");
    initializeDatabase(dbPath);
  });

  afterEach(async () => {
    db.close();
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  it("stores runs and raw events; tool calls come from JSONL, not WebSocket", () => {
    ingestGatewayEvent(JSON.stringify({
      type: "event",
      event: "agent",
      payload: {
        runId: "run-1",
        sessionKey: "agent:direct:telegram:group:-100:topic:1",
        stream: "lifecycle",
        ts: Date.parse("2026-04-01T00:00:00.000Z"),
        data: {
          phase: "start",
          startedAt: Date.parse("2026-04-01T00:00:00.000Z"),
          model: "gpt-5.4",
        },
      },
    }));
    ingestGatewayEvent(JSON.stringify({
      type: "event",
      event: "agent",
      payload: {
        runId: "run-1",
        sessionKey: "agent:direct:telegram:group:-100:topic:1",
        stream: "assistant",
        ts: Date.parse("2026-04-01T00:00:01.000Z"),
        data: {
          text: "hello from gateway",
        },
      },
    }));
    ingestGatewayEvent(JSON.stringify({
      type: "event",
      event: "agent",
      payload: {
        runId: "run-1",
        sessionKey: "agent:direct:telegram:group:-100:topic:1",
        stream: "tool",
        ts: Date.parse("2026-04-01T00:00:02.000Z"),
        data: {
          toolName: "memory_search",
          toolInput: { query: "alpha" },
          toolResult: [{ score: 0.9 }],
          durationMs: 12,
          success: true,
        },
      },
    }));
    ingestGatewayEvent(JSON.stringify({
      type: "event",
      event: "agent",
      payload: {
        runId: "run-1",
        sessionKey: "agent:direct:telegram:group:-100:topic:1",
        stream: "lifecycle",
        ts: Date.parse("2026-04-01T00:00:03.000Z"),
        data: {
          phase: "end",
          endedAt: Date.parse("2026-04-01T00:00:03.000Z"),
        },
      },
    }));

    const runs = db.prepare("SELECT run_id, status FROM agent_runs").all() as Array<{ run_id: string; status: string }>;
    const toolCalls = db.prepare("SELECT tool_name, success FROM tool_calls").all() as Array<{ tool_name: string; success: number }>;
    const events = db.prepare("SELECT COUNT(*) as count FROM events").get() as { count: number };
    const messages = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
    const session = db.prepare("SELECT message_count FROM sessions WHERE session_key = ?").get("agent:direct:telegram:group:-100:topic:1") as {
      message_count: number;
    };

    expect(runs).toEqual([{ run_id: "run-1", status: "completed" }]);
    // Tool calls are no longer inserted from WebSocket — JSONL is the authoritative source
    expect(toolCalls).toEqual([]);
    expect(events.count).toBe(4);
    expect(messages.count).toBe(0);
    expect(session.message_count).toBe(0);
  });
});
