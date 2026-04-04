import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTestPaths,
  removeTestPaths,
  setTestEnv,
  writeTextFile,
  writeJsonFile,
  type TestPaths,
} from "../test-helpers.js";

describe("monitor checks", () => {
  let paths: TestPaths;

  beforeEach(() => {
    vi.resetModules();
    paths = createTestPaths("openclaw-monitor-checks-");
    setTestEnv(paths);
  });

  afterEach(async () => {
    vi.doUnmock("../../lib/system-info.js");
    await removeTestPaths(paths);
  });

  it("evaluates gateway, cron, auth profile, and disk checks", async () => {
    await writeTextFile(
      path.join(paths.openclawHome, "cron", "registry.yaml"),
      [
        "jobs:",
        '  - id: "daily-sync"',
        '    name: "Daily Sync"',
        '    schedule: "*/5 * * * *"',
        '    layer: "openclaw"',
        "    enabled: true",
        '    category: "sync"',
        '    command: "run-daily-sync"',
        '    openclaw_id: "daily-sync"',
        '    description: "Test sync"',
        "    needs_ai: false",
      ].join("\n"),
    );
    await writeTextFile(
      path.join(paths.openclawHome, "cron", "runs", "daily-sync.jsonl"),
      `${JSON.stringify({ ts: Date.now() - 30_000, jobId: "daily-sync", action: "run", status: "error", runAtMs: Date.now() - 30_000 })}\n`,
    );
    await writeJsonFile(path.join(paths.openclawHome, "agents", "direct", "agent", "auth-profiles.json"), {
      profiles: {
        primary: {
          provider: "openai",
          type: "api",
          key: "sk-test",
        },
      },
    });

    vi.doMock("../../lib/system-info.js", () => ({
      getDiskUsage: vi.fn(async () => ({
        filesystem: "/dev/vda1",
        sizeKb: 10000,
        usedKb: 9800,
        availableKb: 200,
        usePercent: 98,
        mount: "/",
      })),
    }));

    const checks = await import("../../monitor/checks/core.js");
    const runtime = await import("../../monitor/runtime-state.js");

    runtime.resetGatewayState();

    const gatewayBooting = await checks.runGatewayCheck();
    expect(gatewayBooting).toMatchObject({
      status: "unknown",
      checkType: "gateway.connection",
    });

    runtime.recordGatewayConnecting();
    runtime.recordGatewayClosed(1006);
    const gatewayDisconnected = await checks.runGatewayCheck();
    expect(gatewayDisconnected).toMatchObject({
      status: "failing",
      summary: "Gateway bridge is disconnected",
    });

    runtime.recordGatewayConnected();
    runtime.recordGatewayAuthFailure({ ok: false, error: "rejected" });
    const gatewayAuthRejected = await checks.runGatewayCheck();
    expect(gatewayAuthRejected).toMatchObject({
      status: "failing",
      summary: "Gateway authentication is failing",
    });

    const cronStatus = await checks.runCronStatusChecks();
    expect(cronStatus[0]).toMatchObject({
      checkType: "cron.job_status",
      targetKey: "daily-sync",
      status: "failing",
    });

    const cronStaleness = await checks.runCronStalenessChecks();
    expect(cronStaleness[0]).toMatchObject({
      checkType: "cron.job_staleness",
      status: "healthy",
    });

    const authProfiles = await checks.runAuthProfilesCheck();
    expect(authProfiles).toMatchObject({
      checkType: "auth.profile_integrity",
      status: "healthy",
    });

    const disk = await checks.runDiskCheck();
    expect(disk).toMatchObject({
      checkType: "system.disk",
      status: "failing",
      severity: "critical",
    });
  });
});
