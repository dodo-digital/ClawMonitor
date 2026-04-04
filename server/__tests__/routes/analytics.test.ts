import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createTestPaths, removeTestPaths, setTestEnv, type TestPaths } from "../test-helpers.js";

async function seedAnalyticsData() {
  const dbModule = await import("../../lib/db.js");
  const { stmts } = dbModule;

  stmts.upsertSession.run({
    session_key: "agent:direct:telegram:group:-100:topic:1",
    agent_id: "direct",
    channel: "telegram",
    channel_name: "telegram:group:-100:topic:1",
    source: "telegram",
    runtime_type: "native",
  });

  stmts.insertRun.run({
    run_id: "run-1",
    session_key: "agent:direct:telegram:group:-100:topic:1",
    agent_id: "direct",
    channel: "telegram",
    channel_name: "telegram:group:-100:topic:1",
    source: "telegram",
    model: "gpt-test",
    started_at: "2999-01-01T00:00:00.000Z",
  });
  stmts.endRun.run({
    run_id: "run-1",
    ended_at: "2999-01-01T00:00:02.000Z",
    duration_ms: 2000,
  });

  stmts.insertMessage.run({
    entry_id: "user-1",
    run_id: "run-1",
    session_key: "agent:direct:telegram:group:-100:topic:1",
    agent_id: "direct",
    role: "user",
    content: "harrison message",
    channel: "telegram",
    channel_name: "telegram:group:-100:topic:1",
    source: "telegram",
    tokens: 10,
    cost_total: null,
    timestamp: "2999-01-01T00:00:00.500Z",
  });

  stmts.insertMessage.run({
    entry_id: "assistant-1",
    run_id: "run-1",
    session_key: "agent:direct:telegram:group:-100:topic:1",
    agent_id: "direct",
    role: "assistant",
    content: "assistant reply",
    channel: "telegram",
    channel_name: "telegram:group:-100:topic:1",
    source: "telegram",
    tokens: 20,
    cost_total: 1.23,
    timestamp: "2999-01-01T00:00:01.000Z",
  });

  stmts.insertToolCall.run({
    tool_call_id: "tool-1",
    run_id: "run-1",
    session_key: "agent:direct:telegram:group:-100:topic:1",
    agent_id: "direct",
    tool_name: "memory_search",
    input: JSON.stringify({ query: "harrison", collection: "life" }),
    output: JSON.stringify([{ score: 0.91, path: "life/harrison.md" }]),
    channel: "telegram",
    source: "telegram",
    duration_ms: 12,
    success: 1,
    timestamp: "2999-01-01T00:00:01.500Z",
  });

  stmts.insertSkillTrigger.run({
    skill_name: "agent-browser",
    agent_id: "direct",
    session_key: "agent:direct:telegram:group:-100:topic:1",
    channel: "telegram",
    channel_name: "telegram:group:-100:topic:1",
    source: "telegram",
    timestamp: "2999-01-01T00:00:01.750Z",
  });

  stmts.insertEvent.run({
    type: "event",
    event: "agent",
    agent_id: "direct",
    run_id: "run-1",
    session_key: "agent:direct:telegram:group:-100:topic:1",
    channel: "telegram",
    channel_name: "telegram:group:-100:topic:1",
    source: "telegram",
    payload: "{\"event\":\"agent\"}",
    timestamp: "2999-01-01T00:00:02.000Z",
  });

  stmts.incrementSessionMetrics.run({
    session_key: "agent:direct:telegram:group:-100:topic:1",
    message_increment: 2,
    token_increment: 30,
  });

  return dbModule;
}

describe("analytics routes", () => {
  let paths: TestPaths;

  beforeEach(() => {
    vi.resetModules();
    paths = createTestPaths("openclaw-analytics-");
    setTestEnv(paths);
  });

  afterEach(async () => {
    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await removeTestPaths(paths);
  });

  it("serves the analytics endpoints", async () => {
    const { createApp } = await import("../../index.js");
    await seedAnalyticsData();
    const app = createApp();

    const summary = await request(app).get("/api/analytics/summary");
    expect(summary.status).toBe(200);
    expect(summary.body.data).toMatchObject({
      last24h: expect.any(Object),
      byChannel: expect.any(Array),
      byAgent: expect.any(Array),
      recentRuns: expect.any(Array),
      totalSessions: expect.any(Number),
      totalMessages: expect.any(Number),
      totalEvents: expect.any(Number),
    });

    const runs = await request(app).get("/api/analytics/runs");
    expect(runs.status).toBe(200);
    expect(runs.body.data.items).toHaveLength(1);

    const messages = await request(app).get("/api/analytics/messages");
    expect(messages.status).toBe(200);
    expect(messages.body.data.items).toHaveLength(2);

    const search = await request(app).get("/api/analytics/messages?search=harrison");
    expect(search.status).toBe(200);
    expect(search.body.data.items).toHaveLength(1);
    expect(search.body.data.items[0].content).toContain("harrison");

    const byRole = await request(app).get("/api/analytics/messages?role=user");
    expect(byRole.status).toBe(200);
    expect(byRole.body.data.items).toHaveLength(1);
    expect(byRole.body.data.items[0].role).toBe("user");

    const toolCalls = await request(app).get("/api/analytics/tool-calls");
    expect(toolCalls.status).toBe(200);
    expect(toolCalls.body.data.items[0]).toMatchObject({
      tool_name: "memory_search",
      count: 1,
    });

    const memorySearches = await request(app).get("/api/analytics/memory-searches");
    expect(memorySearches.status).toBe(200);
    expect(memorySearches.body.data.items[0]).toMatchObject({
      toolName: "memory_search",
      query: "harrison",
      resultCount: 1,
      scores: [0.91],
    });

    const skillUsage = await request(app).get("/api/analytics/skill-usage");
    expect(skillUsage.status).toBe(200);
    expect(skillUsage.body.data.items[0]).toMatchObject({
      skill_name: "agent-browser",
      count: 1,
    });

    const costs = await request(app).get("/api/analytics/costs");
    expect(costs.status).toBe(200);
    expect(costs.body.data).toMatchObject({
      summary: expect.objectContaining({ total_cost: 1.23 }),
      byAgent: expect.any(Array),
      byDay: expect.any(Array),
    });
  });
});
