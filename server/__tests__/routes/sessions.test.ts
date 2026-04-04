import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

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

describe("sessions routes", () => {
  let paths: TestPaths;

  beforeEach(async () => {
    vi.resetModules();
    paths = createTestPaths("openclaw-sessions-");
    setTestEnv(paths);

    await createSessionFixture({
      openclawHome: paths.openclawHome,
      agentId: "direct",
      sessionId: "session-main",
      sessionKey: "agent:direct:main",
      updatedAt: Date.parse("2026-04-01T00:00:00.000Z"),
      lines: [
        line({ type: "custom", timestamp: "2026-04-01T00:00:00.000Z", customType: "model-snapshot", data: { modelId: "x" } }),
        line({
          type: "message",
          timestamp: "2026-04-01T00:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Hello main" }],
          },
        }),
      ],
    });

    await createSessionFixture({
      openclawHome: paths.openclawHome,
      agentId: "direct",
      sessionId: "session-telegram",
      sessionKey: "agent:direct:telegram:group:-1003691004254:topic:1",
      updatedAt: Date.parse("2026-04-02T00:00:00.000Z"),
      lines: [
        line({
          type: "message",
          timestamp: "2026-04-02T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Hello telegram" },
              { type: "toolCall", id: "tool-1", name: "memory_search", arguments: { query: "harrison" } },
            ],
          },
        }),
      ],
    });
  });

  afterEach(async () => {
    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await removeTestPaths(paths);
  });

  it("lists sessions with pagination", async () => {
    const { createApp } = await import("../../index.js");
    const { backfillSessions } = await import("../../lib/session-ingester.js");
    await backfillSessions();
    const response = await request(createApp()).get("/api/sessions");

    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(2);
    expect(response.body.data.items).toHaveLength(2);
  });

  it("filters sessions by agent", async () => {
    const { createApp } = await import("../../index.js");
    const { backfillSessions } = await import("../../lib/session-ingester.js");
    await backfillSessions();
    const response = await request(createApp()).get("/api/sessions?agent=direct");

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(2);
    expect(response.body.data.items.every((item: { agentId: string }) => item.agentId === "direct")).toBe(true);
  });

  it("filters sessions by channel", async () => {
    const { createApp } = await import("../../index.js");
    const { backfillSessions } = await import("../../lib/session-ingester.js");
    await backfillSessions();
    const response = await request(createApp()).get("/api/sessions?channel=telegram");

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].channel).toBe("telegram");
  });

  it("reads a session transcript", async () => {
    const { createApp } = await import("../../index.js");
    const response = await request(createApp()).get("/api/sessions/direct/session-telegram");

    expect(response.status).toBe(200);
    expect(response.body.data.items[0]).toMatchObject({
      type: "message",
      role: "assistant",
    });
    expect(response.body.data.items[0].content).toContain("Hello telegram");
    expect(response.body.data.items[0].toolCalls).toHaveLength(1);
  });

  it("applies transcript offset and limit after filtering message entries", async () => {
    await createSessionFixture({
      openclawHome: paths.openclawHome,
      agentId: "direct",
      sessionId: "session-filtered",
      sessionKey: "agent:direct:slack:team:channel",
      lines: [
        line({ type: "custom", timestamp: "2026-04-02T00:00:00.000Z", customType: "model-snapshot", data: { modelId: "x" } }),
        line({
          type: "message",
          timestamp: "2026-04-02T00:00:01.000Z",
          message: { role: "user", content: "first" },
        }),
        line({ type: "custom", timestamp: "2026-04-02T00:00:02.000Z", customType: "noop", data: {} }),
        line({
          type: "message",
          timestamp: "2026-04-02T00:00:03.000Z",
          message: { role: "assistant", content: "second" },
        }),
      ],
    });

    const { createApp } = await import("../../index.js");
    const response = await request(createApp()).get(
      "/api/sessions/direct/session-filtered?messagesOnly=true&offset=1&limit=1",
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      offset: 1,
      limit: 1,
      hasMore: false,
    });
    expect(response.body.data.items).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "second",
      }),
    ]);
  });

  it("reads large transcript files without loading the entire file into memory", async () => {
    const largeText = "x".repeat(1024 * 1024);
    const entries = Array.from({ length: 55 }, (_, index) =>
      line({
        type: "message",
        timestamp: `2026-04-02T00:00:${String(index).padStart(2, "0")}.000Z`,
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: index === 0 ? largeText : `entry-${index}`,
        },
      }),
    );

    await createSessionFixture({
      openclawHome: paths.openclawHome,
      agentId: "direct",
      sessionId: "session-large",
      sessionKey: "agent:direct:webchat:huge",
      lines: entries,
    });

    const { createApp } = await import("../../index.js");
    const response = await request(createApp()).get("/api/sessions/direct/session-large?offset=1&limit=2");

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(2);
    expect(response.body.data.items[0]).toMatchObject({
      content: "entry-1",
    });
    expect(response.body.data.hasMore).toBe(true);
  });

  it("filters transcript output to message entries only", async () => {
    const { createApp } = await import("../../index.js");
    const response = await request(createApp()).get("/api/sessions/direct/session-main?messagesOnly=true");

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].type).toBe("message");
  });

  it("returns 404 for a missing session", async () => {
    const { createApp } = await import("../../index.js");
    const response = await request(createApp()).get("/api/sessions/direct/nonexistent");

    expect(response.status).toBe(404);
    expect(response.body.ok).toBe(false);
  });

  it("skips malformed jsonl lines when listing sessions", async () => {
    const malformedFixture = await createSessionFixture({
      openclawHome: paths.openclawHome,
      agentId: "direct",
      sessionId: "session-malformed",
      sessionKey: "agent:direct:hook:github",
      lines: [
        "{not-json",
        line({
          type: "message",
          timestamp: "2026-04-03T00:00:00.000Z",
          message: { role: "user", content: "valid" },
        }),
      ],
    });

    await fs.promises.appendFile(malformedFixture.sessionFile, "{still-bad\n", "utf8");

    const { createApp } = await import("../../index.js");
    const { backfillSessions } = await import("../../lib/session-ingester.js");
    await backfillSessions();
    const response = await request(createApp()).get("/api/sessions");

    expect(response.status).toBe(200);
    expect(response.body.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionKey: "agent:direct:hook:github",
          messageCount: 1,
        }),
      ]),
    );
  });

  it("skips malformed jsonl lines when reading a transcript", async () => {
    await createSessionFixture({
      openclawHome: paths.openclawHome,
      agentId: "direct",
      sessionId: "session-malformed-transcript",
      sessionKey: "agent:direct:main:malformed",
      lines: [
        "{not-json",
        line({
          type: "message",
          timestamp: "2026-04-03T00:00:00.000Z",
          message: { role: "assistant", content: "valid transcript entry" },
        }),
      ],
    });

    const { createApp } = await import("../../index.js");
    const response = await request(createApp()).get("/api/sessions/direct/session-malformed-transcript");

    expect(response.status).toBe(200);
    expect(response.body.data.items).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "valid transcript entry",
      }),
    ]);
  });
});
