import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { HttpError } from "./errors.js";

function resolveExistingRealPath(baseDir: string): string {
  return fs.realpathSync(baseDir);
}

export function ensureInsideBase(targetPath: string, baseDir: string): string {
  const realBase = resolveExistingRealPath(baseDir);
  const resolved = path.resolve(baseDir, targetPath);
  const parentDir = path.dirname(resolved);
  const realParent = fs.realpathSync(parentDir);
  const candidate = path.join(realParent, path.basename(resolved));

  if (candidate !== realBase && !candidate.startsWith(`${realBase}${path.sep}`)) {
    throw new HttpError("Path escapes allowed directory", 400);
  }

  return candidate;
}

export async function safeReadTextFile(targetPath: string, baseDir: string): Promise<string> {
  const safePath = ensureInsideBase(targetPath, baseDir);
  return fs.promises.readFile(safePath, "utf8");
}

export async function writeFileWithBackup(
  targetPath: string,
  baseDir: string,
  content: string,
): Promise<{ backupPath: string | null }> {
  const safePath = ensureInsideBase(targetPath, baseDir);
  await fs.promises.writeFile(safePath, content, "utf8");

  return { backupPath: null };
}

export async function atomicWriteJsonFile(targetPath: string, data: unknown): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readJsonFile<T>(targetPath: string): Promise<T> {
  const raw = await fs.promises.readFile(targetPath, "utf8");
  return JSON.parse(raw) as T;
}

export function isSafeTmpLogFile(filename: string): boolean {
  return path.basename(filename) === filename && /^[A-Za-z0-9][A-Za-z0-9._-]*\.log$/.test(filename);
}

export async function resolveSafeTmpLogPath(filename: string): Promise<string> {
  if (!isSafeTmpLogFile(filename)) {
    throw new HttpError("Invalid log filename", 400);
  }

  const tmpDir = await fs.promises.realpath("/tmp");
  const targetPath = path.join(tmpDir, filename);

  let stats: fs.Stats;
  try {
    stats = await fs.promises.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError("Log file not found", 404);
    }
    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw new HttpError("Log file is not readable", 400);
  }
  if (!stats.isFile()) {
    throw new HttpError("Log file not found", 404);
  }

  const realTargetPath = await fs.promises.realpath(targetPath);
  if (realTargetPath !== targetPath) {
    throw new HttpError("Log file is not readable", 400);
  }

  return realTargetPath;
}
