import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSessionFixture,
  createTestPaths,
  removeTestPaths,
  setTestEnv,
  type TestPaths,
} from "../test-helpers.js";

function line(entry: unknown): string {
  return JSON.stringify(entry);
}

describe("session ingester", () => {
  let paths: TestPaths;

  beforeEach(() => {
    vi.resetModules();
    paths = createTestPaths("openclaw-ingester-");
    setTestEnv(paths);
  });

  afterEach(async () => {
    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await removeTestPaths(paths);
  });

  it("ingests messages, tool calls, tool results, dedupes, and supports incremental reads", async () => {
    const sessionKey = "agent:direct:telegram:group:-1003691004254:topic:1";
    const fixture = await createSessionFixture({
      openclawHome: paths.openclawHome,
      sessionKey,
      lines: [
        line({
          type: "message",
          id: "user-1",
          timestamp: "2026-04-01T00:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "hello" }],
            usage: { input: 11 },
          },
        }),
        line({
          type: "message",
          id: "assistant-1",
          timestamp: "2026-04-01T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Looking that up." },
              {
                type: "toolCall",
                id: "tool-1",
                name: "memory_search",
                arguments: { query: "harrison", path: "skills/agent-browser/SKILL.md" },
              },
            ],
            usage: {
              totalTokens: 22,
              cost: { total: 0.75 },
            },
          },
        }),
        line("not json"),
        line({
          type: "message",
          id: "tool-result-1",
          timestamp: "2026-04-01T00:00:02.000Z",
          message: {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "memory_search",
            content: [{ type: "text", text: '[{"score":0.92,"path":"memory/foo.md"}]' }],
          },
        }),
      ],
    });

    const { ingestSessionFile } = await import("../../lib/session-ingester.js");
    const dbModule = await import("../../lib/db.js");

    expect(await ingestSessionFile(fixture.sessionFile, sessionKey, "direct")).toBe(4);

    const messages = dbModule.db.prepare("SELECT role, content, tokens, cost_total FROM messages ORDER BY timestamp").all() as Array<{
      role: string;
      content: string;
      tokens: number | null;
      cost_total: number | null;
    }>;
    const toolCalls = dbModule.db.prepare("SELECT tool_call_id, tool_name, output, success FROM tool_calls").all() as Array<{
      tool_call_id: string | null;
      tool_name: string;
      output: string | null;
      success: number | null;
    }>;
    const skillTriggers = dbModule.db.prepare("SELECT skill_name FROM skill_triggers").all() as Array<{ skill_name: string }>;

    expect(messages).toEqual([
      { role: "user", content: "hello", tokens: 11, cost_total: null },
      { role: "assistant", content: "Looking that up.", tokens: 22, cost_total: 0.75 },
      { role: "toolResult", content: '[{"score":0.92,"path":"memory/foo.md"}]', tokens: null, cost_total: null },
    ]);
    expect(toolCalls).toEqual([
      {
        tool_call_id: "tool-1",
        tool_name: "memory_search",
        output: '[{"score":0.92,"path":"memory/foo.md"}]',
        success: 1,
      },
    ]);
    expect(skillTriggers).toEqual([{ skill_name: "agent-browser" }]);

    expect(await ingestSessionFile(fixture.sessionFile, sessionKey, "direct")).toBe(0);

    await fs.promises.appendFile(
      fixture.sessionFile,
      `${line({
        type: "message",
        id: "assistant-2",
        timestamp: "2026-04-01T00:00:03.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          usage: { totalTokens: 7, cost: { total: 0.1 } },
        },
      })}\n`,
      "utf8",
    );

    expect(await ingestSessionFile(fixture.sessionFile, sessionKey, "direct")).toBe(1);

    const session = dbModule.db.prepare("SELECT message_count, total_tokens FROM sessions WHERE session_key = ?").get(sessionKey) as {
      message_count: number;
      total_tokens: number;
    };
    expect(session).toEqual({
      message_count: 4,
      total_tokens: 40,
    });
  });

  it("returns zero for an empty file", async () => {
    const fixture = await createSessionFixture({
      openclawHome: paths.openclawHome,
      sessionKey: "agent:direct:main",
      lines: [],
    });

    const { ingestSessionFile } = await import("../../lib/session-ingester.js");
    expect(await ingestSessionFile(fixture.sessionFile, "agent:direct:main", "direct")).toBe(0);
  });

  it("backfills all indexed session files", async () => {
    await createSessionFixture({
      openclawHome: paths.openclawHome,
      agentId: "direct",
      sessionId: "session-a",
      sessionKey: "agent:direct:main",
      lines: [
        line({
          type: "message",
          id: "a-1",
          timestamp: "2026-04-01T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "one" }] },
        }),
      ],
    });
    await createSessionFixture({
      openclawHome: paths.openclawHome,
      agentId: "acp-claude",
      sessionId: "session-b",
      sessionKey: "agent:acp-claude:binding:telegram:group:-100:topic:2",
      lines: [
        line({
          type: "message",
          id: "b-1",
          timestamp: "2026-04-01T00:00:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "two" }], usage: { totalTokens: 5 } },
        }),
      ],
    });

    const { backfillSessions } = await import("../../lib/session-ingester.js");
    const dbModule = await import("../../lib/db.js");

    expect(await backfillSessions()).toEqual({ files: 2, entries: 2 });

    const sessions = dbModule.db.prepare("SELECT session_key, agent_id FROM sessions ORDER BY session_key").all() as Array<{
      session_key: string;
      agent_id: string;
    }>;
    expect(sessions).toEqual([
      { session_key: "agent:acp-claude:binding:telegram:group:-100:topic:2", agent_id: "acp-claude" },
      { session_key: "agent:direct:main", agent_id: "direct" },
    ]);
  });

  it("matches concurrent tool results back to the correct tool calls", async () => {
    const sessionKey = "agent:direct:main";
    const fixture = await createSessionFixture({
      openclawHome: paths.openclawHome,
      sessionKey,
      lines: [
        line({
          type: "message",
          id: "assistant-tools",
          timestamp: "2026-04-01T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "tool-a", name: "memory_search", arguments: { query: "alpha" } },
              { type: "toolCall", id: "tool-b", name: "memory_search", arguments: { query: "beta" } },
            ],
            usage: { totalTokens: 3, cost: { total: 0.01 } },
          },
        }),
        line({
          type: "message",
          id: "tool-result-b",
          timestamp: "2026-04-01T00:00:01.000Z",
          message: {
            role: "toolResult",
            toolCallId: "tool-b",
            toolName: "memory_search",
            content: [{ type: "text", text: '[{"query":"beta"}]' }],
          },
        }),
        line({
          type: "message",
          id: "tool-result-a",
          timestamp: "2026-04-01T00:00:02.000Z",
          message: {
            role: "toolResult",
            toolCallId: "tool-a",
            toolName: "memory_search",
            content: [{ type: "text", text: '[{"query":"alpha"}]' }],
          },
        }),
      ],
    });

    const { ingestSessionFile } = await import("../../lib/session-ingester.js");
    const dbModule = await import("../../lib/db.js");

    await ingestSessionFile(fixture.sessionFile, sessionKey, "direct");

    const toolCalls = dbModule.db
      .prepare("SELECT tool_call_id, input, output FROM tool_calls ORDER BY tool_call_id")
      .all() as Array<{ tool_call_id: string; input: string; output: string }>;

    expect(toolCalls).toEqual([
      {
        tool_call_id: "tool-a",
        input: JSON.stringify({ query: "alpha" }),
        output: '[{"query":"alpha"}]',
      },
      {
        tool_call_id: "tool-b",
        input: JSON.stringify({ query: "beta" }),
        output: '[{"query":"beta"}]',
      },
    ]);
  });
});
