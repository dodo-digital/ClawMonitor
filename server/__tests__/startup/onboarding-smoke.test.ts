import { once } from "node:events";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTestPaths,
  removeTestPaths,
  seedOpenClawConfig,
  setTestEnv,
  writeJsonFile,
  writeTextFile,
  type TestPaths,
} from "../test-helpers.js";

async function listen(server: import("node:http").Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not bind to a TCP port");
  }
  return address.port;
}

function runScript(scriptPath: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync("npx", ["tsx", scriptPath, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  }).trim();
}

describe("onboarding smoke", () => {
  let paths: TestPaths;

  beforeEach(async () => {
    vi.resetModules();
    paths = createTestPaths("openclaw-onboarding-");
    setTestEnv(paths);

    await seedOpenClawConfig(paths.openclawHome, {
      gateway: {
        port: 18789,
        auth: {
          token: "test-token",
        },
      },
    });
    await writeJsonFile(path.join(paths.openclawHome, "cron", "jobs.json"), {
      version: 1,
      jobs: [],
    });
    await writeTextFile(path.join(paths.openclawHome, "cron", "registry.yaml"), "jobs: []\n");
  });

  afterEach(async () => {
    try {
      const dbModule = await import("../../lib/db.js");
      if (typeof dbModule.db !== "undefined") {
        dbModule.db.close();
      }
    } catch {
      // ignore cleanup if startup failed before DB init
    }
    await removeTestPaths(paths);
  });

  it("serves health and root, and exposes both CLI help commands", async () => {
    const env = {
      OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789",
      OPENCLAW_GATEWAY_WS: "ws://127.0.0.1:18789",
      OPENCLAW_GATEWAY_TOKEN: "test-token",
      OPENCLAW_HOME: paths.openclawHome,
      OPENCLAW_WORKSPACE: paths.workspaceDir,
      PORT: "18801",
    };

    const monitorCliPath = path.resolve(import.meta.dirname, "../../scripts/monitor-cli.ts");
    const cronCliPath = path.resolve(import.meta.dirname, "../../scripts/cron-cli.ts");

    const monitorHelp = runScript(monitorCliPath, env, "--help");
    const cronHelp = runScript(cronCliPath, env, "--help");

    expect(monitorHelp).toContain("monitor-cli");
    expect(cronHelp).toContain("cron-cli");

    const { createHttpServer } = await import("../../index.js");
    const { server } = createHttpServer({ attachLiveFeed: false });

    try {
      const port = await listen(server);
      const [healthResponse, rootResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/health`),
        fetch(`http://127.0.0.1:${port}/`),
      ]);

      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({
        ok: true,
        data: { status: "ok" },
      });

      expect(rootResponse.status).toBe(200);
      expect(await rootResponse.text()).toContain("<div id=\"root\"></div>");
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  });
});
