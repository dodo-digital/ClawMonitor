import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestPaths,
  removeTestPaths,
  writeJsonFile,
  writeTextFile,
  type TestPaths,
} from "../test-helpers.js";

let paths: TestPaths;

function cli(...args: string[]): string {
  const cliPath = path.resolve(import.meta.dirname, "../../scripts/cron-cli.ts");
  return execFileSync("npx", ["tsx", cliPath, ...args], {
    env: {
      ...process.env,
      OPENCLAW_HOME: paths.openclawHome,
      HOME: paths.rootDir,
    },
    timeout: 15_000,
    encoding: "utf8",
  }).trim();
}

function cliError(...args: string[]): string {
  const cliPath = path.resolve(import.meta.dirname, "../../scripts/cron-cli.ts");
  const result = spawnSync("npx", ["tsx", cliPath, ...args], {
    env: {
      ...process.env,
      OPENCLAW_HOME: paths.openclawHome,
      HOME: paths.rootDir,
    },
    timeout: 15_000,
    encoding: "utf8",
  });

  if (result.status === 0) {
    throw new Error("Expected command to fail");
  }

  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

beforeAll(async () => {
  paths = createTestPaths("cron-cli-test-");

  await writeTextFile(
    path.join(paths.openclawHome, "cron", "registry.yaml"),
    [
      "jobs:",
      '  - id: "linux-sync"',
      '    name: "Linux Sync"',
      '    schedule: "*/5 * * * *"',
      '    layer: "linux"',
      "    enabled: true",
      '    category: "infrastructure"',
      '    command: "printf \'sync ok\\n\'"',
      `    log: "${path.join(paths.rootDir, "linux-sync.log")}"`,
      '    description: "Syncs files"',
      "    expects:",
      "      exit_code: 0",
      '      log_contains: "sync ok"',
      '      log_not_contains: "ERROR"',
      "    needs_ai: false",
      '  - id: "openclaw-digest"',
      '    name: "OpenClaw Digest"',
      '    schedule: "0 8 * * *"',
      '    layer: "openclaw"',
      "    enabled: true",
      '    category: "agent-task"',
      '    command: "Review the overnight incidents and write a summary for operators."',
      '    openclaw_id: "openclaw-digest"',
      '    description: "Runs the digest agent"',
      "    needs_ai: true",
      '  - id: "missing-log"',
      '    name: "Missing Log"',
      '    schedule: "0 * * * *"',
      '    layer: "linux"',
      "    enabled: true",
      '    category: "infrastructure"',
      '    command: "printf \'no log\\n\'"',
      `    log: "${path.join(paths.rootDir, "missing.log")}"`,
      '    description: "Has no logfile yet"',
      "    needs_ai: false",
      "",
    ].join("\n"),
  );

  await writeJsonFile(path.join(paths.openclawHome, "cron", "jobs.json"), {
    version: 1,
    jobs: [
      {
        id: "openclaw-digest",
        name: "OpenClaw Digest",
        enabled: false,
        agentId: "direct",
        sessionTarget: "isolated",
        state: {
          lastStatus: "error",
          lastRunAtMs: Date.parse("2026-04-03T08:15:00.000Z"),
          lastDurationMs: 4500,
          consecutiveErrors: 2,
          lastError: "Gateway timeout",
        },
      },
    ],
  });

  await writeTextFile(path.join(paths.rootDir, "linux-sync.log"), "sync ok\ncompleted successfully\n");
  await writeTextFile(
    path.join(paths.openclawHome, "cron", "runs", "openclaw-digest.jsonl"),
    [
      JSON.stringify({
        startedAt: "2026-04-03T07:00:00.000Z",
        status: "ok",
        durationMs: 3200,
      }),
      JSON.stringify({
        startedAt: "2026-04-03T08:00:00.000Z",
        status: "error",
        durationMs: 4500,
      }),
      "",
    ].join("\n"),
  );
  await writeTextFile(path.join(paths.openclawHome, "cron", "runs", "broken-run.jsonl"), "{not-json\n");
});

afterAll(async () => {
  await removeTestPaths(paths);
});

describe("cron-cli", () => {
  it("lists mixed linux and openclaw jobs", () => {
    const output = cli("list");

    expect(output).toContain("linux-sync");
    expect(output).toContain("openclaw-digest");
    expect(output).toContain("missing-log");
    expect(output).toContain("3 job(s)");
  });

  it("shows openclaw job details with run history and jobs.json state", () => {
    const output = cli("show", "openclaw-digest");

    expect(output).toContain("Job: openclaw-digest");
    expect(output).toContain("OpenClaw ID: openclaw-digest");
    expect(output).toContain("State from jobs.json:");
    expect(output).toContain("Gateway timeout");
  });

  it("reports per-job health and summary counts", () => {
    const output = cli("health");

    expect(output).toContain("linux-sync");
    expect(output).toContain("HEALTHY");
    expect(output).toContain("openclaw-digest");
    expect(output).toContain("FAILING");
    expect(output).toContain("missing-log");
    expect(output).toContain("UNKNOWN");
    expect(output).toContain("Summary: 1 healthy, 1 failing, 0 disabled, 1 unknown");
  });

  it("tails linux logs and openclaw run history", () => {
    const linuxOutput = cli("logs", "linux-sync", "--lines", "2");
    expect(linuxOutput).toContain("linux-sync.log");
    expect(linuxOutput).toContain("completed successfully");

    const openClawOutput = cli("logs", "openclaw-digest", "--lines", "1");
    expect(openClawOutput).toContain("openclaw-digest.jsonl");
    expect(openClawOutput).toContain("\"status\":\"error\"");
  });

  it("supports debug output and shell test runs", () => {
    const debugOutput = cli("debug", "linux-sync");
    expect(debugOutput).toContain("===== DEBUG: linux-sync =====");
    expect(debugOutput).toContain("--- Registry Entry ---");
    expect(debugOutput).toContain("--- Health Check ---");
    expect(debugOutput).toContain("--- Recent Logs ---");

    const testOutput = cli("test", "linux-sync");
    expect(testOutput).toContain("Running: printf");
    expect(testOutput).toContain("Exit code: 0");
    expect(testOutput).toContain("RESULT: HEALTHY");
  });

  it("toggles openclaw jobs in both registry and jobs.json", async () => {
    const disableOutput = cli("disable", "openclaw-digest");
    expect(disableOutput).toContain("Registry updated: openclaw-digest enabled=false");
    expect(disableOutput).toContain("jobs.json updated: openclaw-digest enabled=false");

    const jobsAfterDisable = JSON.parse(
      await fs.promises.readFile(path.join(paths.openclawHome, "cron", "jobs.json"), "utf8"),
    ) as { jobs: Array<{ id: string; enabled: boolean }> };
    expect(jobsAfterDisable.jobs.find((job) => job.id === "openclaw-digest")?.enabled).toBe(false);

    const enableOutput = cli("enable", "openclaw-digest");
    expect(enableOutput).toContain("Registry updated: openclaw-digest enabled=true");
    expect(enableOutput).toContain("jobs.json updated: openclaw-digest enabled=true");
  });

  it("preserves missing-log and malformed-registry failure behavior", async () => {
    const missingLogOutput = cliError("logs", "missing-log");
    expect(missingLogOutput).toContain("No log file found for missing-log");

    const registryPath = path.join(paths.openclawHome, "cron", "registry.yaml");
    const originalRegistry = await fs.promises.readFile(registryPath, "utf8");
    await fs.promises.writeFile(registryPath, "jobs: [", "utf8");

    const malformedOutput = cliError("list");
    expect(malformedOutput).toContain("YAMLException");

    await fs.promises.writeFile(registryPath, originalRegistry, "utf8");
  });
});
