import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createTestPaths, removeTestPaths, setTestEnv, writeJsonFile, type TestPaths } from "../test-helpers.js";

describe("cron routes", () => {
  let paths: TestPaths;
  let logPath: string;

  beforeEach(async () => {
    vi.resetModules();
    paths = createTestPaths("openclaw-cron-");
    setTestEnv(paths);
    await writeJsonFile(path.join(paths.openclawHome, "cron", "jobs.json"), {
      jobs: [
        {
          id: "job-1",
          name: "Daily Memory",
          agentId: "direct",
          enabled: true,
          schedule: "0 0 * * *",
          sessionTarget: "agent:direct:main",
          delivery: { mode: "append" },
        },
      ],
    });

    logPath = path.join(os.tmpdir(), "qmd-update.log");
    await fs.promises.writeFile(logPath, "line 1\nline 2\n", "utf8");
  });

  afterEach(async () => {
    vi.doUnmock("../../lib/process.js");
    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await fs.promises.rm(logPath, { force: true });
    await removeTestPaths(paths);
  });

  it("reads internal cron state, parses crontab, and tails logs", async () => {
    const runCommand = vi.fn(async (file: string, args: string[]) => {
      if (file === "crontab") {
        return {
          stdout: "*/5 * * * * /usr/bin/node script.js > /tmp/qmd-update.log 2>&1\n",
          stderr: "",
        };
      }

      if (file === "tail") {
        expect(args[2]).toBe(logPath);
        return { stdout: "line 1\nline 2\n", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    });

    vi.doMock("../../lib/process.js", () => ({ runCommand }));

    const { createApp } = await import("../../index.js");
    const app = createApp();

    const internal = await request(app).get("/api/cron/internal");
    expect(internal.status).toBe(200);
    expect(internal.body.data[0]).toMatchObject({
      id: "job-1",
      deliveryMode: "append",
    });

    const system = await request(app).get("/api/cron/system");
    expect(system.status).toBe(200);
    expect(system.body.data[0]).toMatchObject({
      schedule: "*/5 * * * *",
      logFile: "/tmp/qmd-update.log",
    });

    const log = await request(app).get("/api/cron/log/qmd-update.log");
    expect(log.status).toBe(200);
    expect(log.body.data.content).toContain("line 1");

    const invalidLog = await request(app).get("/api/cron/log/..%2F..%2F..%2Fetc%2Fpasswd");
    expect(invalidLog.status).toBe(400);
  });

  it("toggles cron jobs with an atomic write and rejects unknown ids", async () => {
    const renameSpy = vi.spyOn(fs.promises, "rename");

    const { createApp } = await import("../../index.js");
    const app = createApp();

    const updated = await request(app).put("/api/cron/internal/job-1");
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({
      id: "job-1",
      enabled: false,
    });
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy.mock.calls[0]?.[0]).toContain(".tmp");
    expect(renameSpy.mock.calls[0]?.[1]).toBe(path.join(paths.openclawHome, "cron", "jobs.json"));

    const jobs = JSON.parse(
      await fs.promises.readFile(path.join(paths.openclawHome, "cron", "jobs.json"), "utf8"),
    ) as { jobs: Array<{ enabled: boolean }> };
    expect(jobs.jobs[0]?.enabled).toBe(false);

    const missing = await request(app).put("/api/cron/internal/missing-job");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      ok: false,
      error: "Cron job not found",
    });
  });

  it("rejects symlinked tmp logs", async () => {
    const symlinkPath = path.join(os.tmpdir(), "symlinked-qmd.log");
    await fs.promises.symlink("/etc/passwd", symlinkPath);

    try {
      const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
      vi.doMock("../../lib/process.js", () => ({ runCommand }));

      const { createApp } = await import("../../index.js");
      const response = await request(createApp()).get("/api/cron/log/symlinked-qmd.log");

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        ok: false,
        error: "Log file is not readable",
      });
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      await fs.promises.rm(symlinkPath, { force: true });
    }
  });
});
