import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import {
  createSessionFixture,
  createTestPaths,
  removeTestPaths,
  setTestEnv,
  type TestPaths,
} from "../test-helpers.js";

describe("skills routes", () => {
  let paths: TestPaths;

  beforeEach(async () => {
    vi.resetModules();
    paths = createTestPaths("openclaw-skills-");
    setTestEnv(paths);

    const recentTs = "2999-01-01T00:00:00.000Z";
    const oldTs = "2000-01-01T00:00:00.000Z";

    await createSessionFixture({
      openclawHome: paths.openclawHome,
      agentId: "direct",
      sessionId: "skills-direct",
      sessionKey: "agent:direct:main",
      lines: [
        JSON.stringify({
          type: "message",
          timestamp: recentTs,
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tool-1",
                name: "read",
                arguments: {
                  path: "skills/agent-browser/SKILL.md",
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: recentTs,
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tool-2",
                name: "read",
                arguments: {
                  path: "skills/agent-browser/SKILL.md",
                },
              },
            ],
          },
        }),
      ],
    });

    await createSessionFixture({
      openclawHome: paths.openclawHome,
      agentId: "acp-claude",
      sessionId: "skills-acp",
      sessionKey: "agent:acp-claude:binding:telegram:group:-100:topic:2",
      lines: [
        JSON.stringify({
          type: "message",
          timestamp: oldTs,
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tool-3",
                name: "read",
                arguments: {
                  path: "skills/old-skill/SKILL.md",
                },
              },
            ],
          },
        }),
      ],
    });

    await fs.promises.utimes(
      path.join(paths.openclawHome, "agents", "direct", "sessions", "skills-direct.jsonl"),
      new Date(recentTs),
      new Date(recentTs),
    );
    await fs.promises.utimes(
      path.join(paths.openclawHome, "agents", "acp-claude", "sessions", "skills-acp.jsonl"),
      new Date(oldTs),
      new Date(oldTs),
    );
  });

  afterEach(async () => {
    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await removeTestPaths(paths);
  });

  it("aggregates recent skill usage from session jsonl files", async () => {
    const { createApp } = await import("../../index.js");
    const response = await request(createApp()).get("/api/skills/usage");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      {
        skill: "agent-browser",
        triggerCount: 2,
        lastUsed: "2999-01-01T00:00:00.000Z",
        channels: ["direct"],
      },
    ]);
  });
});
