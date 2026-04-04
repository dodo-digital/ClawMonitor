import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import {
  createSessionFixture,
  createTestPaths,
  removeTestPaths,
  seedOpenClawConfig,
  setTestEnv,
  writeJsonFile,
  type TestPaths,
} from "../test-helpers.js";

describe("agents routes", () => {
  let paths: TestPaths;

  beforeEach(async () => {
    vi.resetModules();
    paths = createTestPaths("openclaw-agents-");
    setTestEnv(paths);
    await seedOpenClawConfig(paths.openclawHome);

    await createSessionFixture({
      openclawHome: paths.openclawHome,
      agentId: "direct",
      sessionId: "direct-session",
      sessionKey: "agent:direct:main",
      lines: [
        JSON.stringify({
          type: "message",
          timestamp: "2026-04-01T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        }),
      ],
    });

    await createSessionFixture({
      openclawHome: paths.openclawHome,
      agentId: "acp-claude",
      sessionId: "acp-session",
      sessionKey: "agent:acp-claude:binding:telegram:group:-100:topic:2",
      lines: [
        JSON.stringify({
          type: "message",
          timestamp: "2026-04-01T00:00:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        }),
      ],
    });

    await writeJsonFile(
      `${paths.openclawHome}/agents/direct/agent/auth-profiles.json`,
      {
        profiles: {
          primary: {
            key: "sk-test",
            provider: "openai",
            type: "api",
          },
          oauth: {
            access: "access-token",
            provider: "anthropic",
            type: "oauth",
          },
        },
      },
    );
  });

  afterEach(async () => {
    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await removeTestPaths(paths);
  });

  it("returns agent listings, auth profiles, and acp config", async () => {
    const { createApp } = await import("../../index.js");
    const app = createApp();

    const listing = await request(app).get("/api/agents");
    expect(listing.status).toBe(200);
    expect(listing.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "direct",
          workspace: "/workspace/direct",
          model: "gpt-direct",
          runtimeType: "native",
          telegramBinding: expect.any(Object),
          sessionCount: 1,
        }),
        expect.objectContaining({
          id: "acp-claude",
          workspace: "/workspace/acp",
          model: "gpt-default",
          runtimeType: "acp",
          sessionCount: 1,
        }),
      ]),
    );

    const authProfiles = await request(app).get("/api/agents/auth-profiles");
    expect(authProfiles.status).toBe(200);
    expect(authProfiles.body.data).toEqual(
      expect.arrayContaining([
        {
          name: "primary",
          status: {
            hasApiKey: true,
            hasAccessToken: false,
            provider: "openai",
            type: "api",
          },
        },
        {
          name: "oauth",
          status: {
            hasApiKey: false,
            hasAccessToken: true,
            provider: "anthropic",
            type: "oauth",
          },
        },
      ]),
    );

    const acp = await request(app).get("/api/agents/acp");
    expect(acp.status).toBe(200);
    expect(acp.body.data).toMatchObject({
      enabled: true,
      providers: ["claude"],
    });
  });
});
