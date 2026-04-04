import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTestPaths,
  removeTestPaths,
  setTestEnv,
  writeJsonFile,
  type TestPaths,
} from "../test-helpers.js";

describe("exec security checks", () => {
  let paths: TestPaths;

  beforeEach(() => {
    vi.resetModules();
    paths = createTestPaths("openclaw-exec-security-");
    setTestEnv(paths);
  });

  afterEach(async () => {
    vi.doUnmock("../../lib/system-info.js");
    await removeTestPaths(paths);
  });

  async function seedConfigs(
    openclawJsonExec: Record<string, unknown> = {},
    approvalsDefaults: Record<string, unknown> = {},
    approvalsAgents: Record<string, unknown> = {},
  ) {
    await writeJsonFile(path.join(paths.openclawHome, "openclaw.json"), {
      meta: { lastTouchedVersion: "2026.4.1" },
      tools: { exec: openclawJsonExec },
    });
    await writeJsonFile(path.join(paths.openclawHome, "exec-approvals.json"), {
      version: 1,
      defaults: approvalsDefaults,
      agents: approvalsAgents,
    });
  }

  it("reports healthy when all settings are in autonomous mode", async () => {
    await seedConfigs(
      { security: "full", strictInlineEval: false, ask: "off" },
      { security: "full", ask: "off", askFallback: "full" },
      { "*": { allowlist: [{ pattern: "*" }] } },
    );

    vi.doMock("../../lib/system-info.js", () => ({
      getDiskUsage: vi.fn(async () => ({ usePercent: 50, mount: "/" })),
    }));

    const { readExecSecurityStatus, runExecSecurityCheck } = await import(
      "../../monitor/checks/core.js"
    );

    const status = await readExecSecurityStatus();
    expect(status.cronReady).toBe(true);
    expect(status.cronBlockers).toEqual([]);
    expect(status.settings.gatewayExecSecurity).toBe("full");
    expect(status.settings.approvalsDefaultSecurity).toBe("full");
    expect(status.settings.approvalsDefaultAsk).toBe("off");
    expect(status.settings.approvalsHasWildcard).toBe(true);

    const check = await runExecSecurityCheck();
    expect(check.status).toBe("healthy");
  });

  it("detects gateway security set to deny", async () => {
    await seedConfigs(
      { security: "deny" },
      { security: "full", ask: "off", askFallback: "full" },
      { "*": { allowlist: [{ pattern: "*" }] } },
    );

    vi.doMock("../../lib/system-info.js", () => ({
      getDiskUsage: vi.fn(async () => ({ usePercent: 50, mount: "/" })),
    }));

    const { readExecSecurityStatus } = await import("../../monitor/checks/core.js");
    const status = await readExecSecurityStatus();

    expect(status.cronReady).toBe(false);
    expect(status.cronBlockers).toHaveLength(1);
    expect(status.cronBlockers[0]).toContain("deny");
  });

  it("detects allowlist mode on gateway", async () => {
    await seedConfigs(
      { security: "allowlist" },
      { security: "full", ask: "off", askFallback: "full" },
      { "*": { allowlist: [{ pattern: "*" }] } },
    );

    vi.doMock("../../lib/system-info.js", () => ({
      getDiskUsage: vi.fn(async () => ({ usePercent: 50, mount: "/" })),
    }));

    const { readExecSecurityStatus } = await import("../../monitor/checks/core.js");
    const status = await readExecSecurityStatus();

    expect(status.cronReady).toBe(false);
    expect(status.cronBlockers.some((b) => b.includes("allowlist"))).toBe(true);
  });

  it("detects approval prompts with deny fallback as a cron blocker", async () => {
    await seedConfigs(
      { security: "full" },
      { security: "full", ask: "on-miss", askFallback: "deny" },
      { "*": { allowlist: [{ pattern: "*" }] } },
    );

    vi.doMock("../../lib/system-info.js", () => ({
      getDiskUsage: vi.fn(async () => ({ usePercent: 50, mount: "/" })),
    }));

    const { readExecSecurityStatus } = await import("../../monitor/checks/core.js");
    const status = await readExecSecurityStatus();

    expect(status.cronReady).toBe(false);
    expect(status.cronBlockers.some((b) => b.includes("deny") && b.includes("Control UI"))).toBe(true);
  });

  it("considers supervised mode with full fallback as cron-ready", async () => {
    await seedConfigs(
      { security: "full" },
      { security: "full", ask: "on-miss", askFallback: "full" },
      { "*": { allowlist: [{ pattern: "*" }] } },
    );

    vi.doMock("../../lib/system-info.js", () => ({
      getDiskUsage: vi.fn(async () => ({ usePercent: 50, mount: "/" })),
    }));

    const { readExecSecurityStatus } = await import("../../monitor/checks/core.js");
    const status = await readExecSecurityStatus();

    expect(status.cronReady).toBe(true);
  });

  it("handles missing config files gracefully", async () => {
    // Don't seed any configs — files won't exist

    vi.doMock("../../lib/system-info.js", () => ({
      getDiskUsage: vi.fn(async () => ({ usePercent: 50, mount: "/" })),
    }));

    const { readExecSecurityStatus } = await import("../../monitor/checks/core.js");
    const status = await readExecSecurityStatus();

    expect(status.settings.gatewayExecSecurity).toBeNull();
    expect(status.settings.approvalsDefaultSecurity).toBeNull();
    expect(status.cronReady).toBe(false);
  });

  it("detects missing wildcard in allowlist agents", async () => {
    await seedConfigs(
      { security: "allowlist" },
      { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      { "*": { allowlist: [] } }, // empty allowlist, no wildcard
    );

    vi.doMock("../../lib/system-info.js", () => ({
      getDiskUsage: vi.fn(async () => ({ usePercent: 50, mount: "/" })),
    }));

    const { readExecSecurityStatus } = await import("../../monitor/checks/core.js");
    const status = await readExecSecurityStatus();

    expect(status.settings.approvalsHasWildcard).toBe(false);
  });

  it("write round-trips preserve existing config", async () => {
    await writeJsonFile(path.join(paths.openclawHome, "openclaw.json"), {
      meta: { lastTouchedVersion: "2026.4.1" },
      tools: { exec: { security: "deny" }, web: { enabled: true } },
      agents: { list: [] },
    });
    await writeJsonFile(path.join(paths.openclawHome, "exec-approvals.json"), {
      version: 1,
      socket: { path: "/tmp/test.sock" },
      defaults: { security: "deny", ask: "always" },
      agents: { "*": { allowlist: [] } },
    });

    vi.doMock("../../lib/system-info.js", () => ({
      getDiskUsage: vi.fn(async () => ({ usePercent: 50, mount: "/" })),
    }));

    const { writeExecSecuritySettings, readExecSecurityStatus } = await import(
      "../../monitor/checks/core.js"
    );

    await writeExecSecuritySettings({
      gatewayExecSecurity: "full",
      approvalsDefaultSecurity: "full",
      approvalsDefaultAsk: "off",
    });

    // Verify the write
    const status = await readExecSecurityStatus();
    expect(status.settings.gatewayExecSecurity).toBe("full");
    expect(status.settings.approvalsDefaultSecurity).toBe("full");
    expect(status.settings.approvalsDefaultAsk).toBe("off");

    // Verify non-exec config was preserved
    const rawConfig = JSON.parse(
      await fs.promises.readFile(path.join(paths.openclawHome, "openclaw.json"), "utf8"),
    );
    expect(rawConfig.tools.web).toEqual({ enabled: true });
    expect(rawConfig.agents).toEqual({ list: [] });

    // Verify non-defaults approval data was preserved
    const rawApprovals = JSON.parse(
      await fs.promises.readFile(path.join(paths.openclawHome, "exec-approvals.json"), "utf8"),
    );
    expect(rawApprovals.socket.path).toBe("/tmp/test.sock");
    expect(rawApprovals.agents).toEqual({ "*": { allowlist: [] } });
  });
});
