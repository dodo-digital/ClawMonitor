import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "../../lib/errors.js";
import { atomicWriteJsonFile, ensureInsideBase, isSafeTmpLogFile, resolveSafeTmpLogPath } from "../../lib/filesystem.js";

describe("filesystem helpers", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fs-"));
    fs.writeFileSync(path.join(baseDir, "SOUL.md"), "soul\n");
  });

  afterEach(async () => {
    await fs.promises.rm(baseDir, { recursive: true, force: true });
  });

  it("keeps a normal path inside the base directory", () => {
    expect(ensureInsideBase("SOUL.md", baseDir)).toBe(path.join(baseDir, "SOUL.md"));
  });

  it("rejects path traversal", () => {
    expect(() => ensureInsideBase("../../../etc/passwd", baseDir)).toThrowError(HttpError);
  });

  it("rejects an absolute escape path", () => {
    expect(() => ensureInsideBase("/etc/passwd", baseDir)).toThrowError(HttpError);
  });

  it("accepts safe tmp log filenames", () => {
    expect(isSafeTmpLogFile("qmd-update.log")).toBe(true);
    expect(isSafeTmpLogFile("memory-rollup.log")).toBe(true);
  });

  it("rejects unsafe tmp log filenames", () => {
    expect(isSafeTmpLogFile("../secret.log")).toBe(false);
    expect(isSafeTmpLogFile("/etc/passwd")).toBe(false);
  });

  it("rejects symlinked tmp logs", async () => {
    const logPath = path.join("/tmp", `openclaw-filesystem-${Date.now()}.log`);
    await fs.promises.symlink("/etc/passwd", logPath);

    try {
      await expect(resolveSafeTmpLogPath(path.basename(logPath))).rejects.toThrowError(HttpError);
    } finally {
      await fs.promises.rm(logPath, { force: true });
    }
  });

  it("writes json atomically via a temp file and rename", async () => {
    const targetPath = path.join(baseDir, "jobs.json");
    const renameSpy = vi.spyOn(fs.promises, "rename");

    await atomicWriteJsonFile(targetPath, { jobs: [{ id: "job-1", enabled: true }] });

    expect(JSON.parse(await fs.promises.readFile(targetPath, "utf8"))).toEqual({
      jobs: [{ id: "job-1", enabled: true }],
    });
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy.mock.calls[0]?.[0]).toContain(".tmp");
    expect(renameSpy.mock.calls[0]?.[1]).toBe(targetPath);
  });
});
