import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import {
  createTestPaths,
  removeTestPaths,
  seedOpenClawConfig,
  setTestEnv,
  writeTextFile,
  type TestPaths,
} from "../test-helpers.js";

describe("system routes", () => {
  let paths: TestPaths;

  beforeEach(async () => {
    vi.resetModules();
    paths = createTestPaths("openclaw-system-");
    setTestEnv(paths);
    await seedOpenClawConfig(paths.openclawHome);
    await writeTextFile(
      path.join(paths.openclawHome, "logs", "commands.log"),
      [
        JSON.stringify({ timestamp: "2999-01-01T00:00:00.000Z", action: "new", source: "telegram" }),
        JSON.stringify({ timestamp: "2999-01-01T01:00:00.000Z", action: "new", source: "webchat" }),
        JSON.stringify({ timestamp: "2000-01-01T00:00:00.000Z", action: "new", source: "telegram" }),
        JSON.stringify({ timestamp: "2999-01-01T02:00:00.000Z", action: "noop", source: "telegram" }),
      ].join("\n"),
    );
  });

  afterEach(async () => {
    vi.doUnmock("../../lib/system-info.js");
    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await removeTestPaths(paths);
  });

  it("serves system endpoints with mocked command/system data", async () => {
    vi.doMock("../../lib/system-info.js", () => ({
      getSystemHealth: vi.fn(async () => ({
        cpu: { load1: 0.1, load5: 0.2, load15: 0.3, cores: 4 },
        memory: { totalKb: 1000, availableKb: 250, usedKb: 750, usedPercent: 75 },
        disk: {
          filesystem: "/dev/vda1",
          sizeKb: 10000,
          usedKb: 6000,
          availableKb: 4000,
          usePercent: 60,
          mount: "/",
        },
        uptimeSeconds: 123,
      })),
      getUserServices: vi.fn(async () => "openclaw-gateway.service loaded active running"),
      getTailscaleStatus: vi.fn(async () => "100.64.0.1 online"),
      getOpenClawVersionAndPid: vi.fn(async () => ({ version: "v2026.4.1", pid: 4242 })),
      getGatewayModels: vi.fn(async () => ({ data: [{ id: "gpt-5.4" }] })),
      getQmdStatusOutput: vi.fn(async () => ""),
    }));

    const { createApp } = await import("../../index.js");
    const app = createApp();

    const health = await request(app).get("/api/system/health");
    expect(health.status).toBe(200);
    expect(health.body.data).toMatchObject({
      cpu: { load1: 0.1, cores: 4 },
      memory: { usedPercent: 75 },
      disk: { usePercent: 60 },
      uptimeSeconds: 123,
    });

    const services = await request(app).get("/api/system/services");
    expect(services.status).toBe(200);
    expect(services.body.data.raw).toContain("openclaw-gateway.service");

    const tailscale = await request(app).get("/api/system/tailscale");
    expect(tailscale.status).toBe(200);
    expect(tailscale.body.data.raw).toContain("online");

    const openclaw = await request(app).get("/api/system/openclaw");
    expect(openclaw.status).toBe(200);
    expect(openclaw.body.data).toMatchObject({
      version: "v2026.4.1",
      gatewayPid: 4242,
      configSummary: expect.objectContaining({
        agentCount: 2,
        bindingCount: 1,
        acpEnabled: true,
      }),
    });

    const models = await request(app).get("/api/system/models");
    expect(models.status).toBe(200);
    expect(models.body.data).toEqual({ data: [{ id: "gpt-5.4" }] });

    const summary = await request(app).get("/api/system/summary");
    expect(summary.status).toBe(200);
    expect(summary.body.data).toEqual({
      totalSessions: 2,
      bySource: {
        telegram: 1,
        webchat: 1,
      },
    });
  });
});
