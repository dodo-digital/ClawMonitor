import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

import { env } from "../lib/env.js";

export interface RegistryExpects {
  exit_code?: number;
  log_contains?: string;
  log_not_contains?: string;
}

export interface RegistryJob {
  id: string;
  name: string;
  schedule: string;
  layer: "linux" | "openclaw";
  enabled: boolean;
  category: string;
  command: string;
  log?: string;
  openclaw_id?: string;
  description: string;
  expects?: RegistryExpects;
  needs_ai: boolean;
}

export interface RegistryFile {
  jobs: RegistryJob[];
  archived?: RegistryJob[];
}

export interface RunEntry {
  ts: number;
  jobId: string;
  action: string;
  status: string;
  summary?: string;
  runAtMs?: number;
  durationMs?: number;
  sessionKey?: string;
}

export function cronRegistryPath(): string {
  return path.join(env.openclawHome, "cron", "registry.yaml");
}

export async function readCronRegistry(): Promise<RegistryFile> {
  const raw = await fs.promises.readFile(cronRegistryPath(), "utf8");
  return yaml.load(raw) as RegistryFile;
}

export async function writeCronRegistry(data: RegistryFile): Promise<void> {
  const raw = yaml.dump(data, { lineWidth: 120, noRefs: true, quotingType: '"' });
  await fs.promises.writeFile(cronRegistryPath(), raw, "utf8");
}

export async function getRegistryRunHistory(job: RegistryJob, limit = 20): Promise<RunEntry[]> {
  if (job.layer === "openclaw" && job.openclaw_id) {
    const runFile = path.join(env.openclawHome, "cron", "runs", `${job.openclaw_id}.jsonl`);
    try {
      const raw = await fs.promises.readFile(runFile, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .reverse()
        .map((line) => JSON.parse(line) as RunEntry);
    } catch {
      return [];
    }
  }

  return [];
}

export function estimateScheduleIntervalMs(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (minute.startsWith("*/") && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const value = Number(minute.slice(2));
    return Number.isFinite(value) && value > 0 ? value * 60_000 : null;
  }

  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return 60 * 60_000;
  }

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return 24 * 60 * 60_000;
  }

  if (dayOfMonth === "*" && month === "*" && dayOfWeek !== "*") {
    return 7 * 24 * 60 * 60_000;
  }

  if (dayOfMonth !== "*" && month === "*") {
    return 31 * 24 * 60 * 60_000;
  }

  return null;
}

export async function getRegistryJobLastObservedAt(job: RegistryJob): Promise<number | null> {
  if (job.layer === "openclaw" && job.openclaw_id) {
    const runs = await getRegistryRunHistory(job, 1);
    const lastRun = runs[0];
    return lastRun ? (lastRun.runAtMs ?? lastRun.ts) : null;
  }

  if (job.log) {
    try {
      const stat = await fs.promises.stat(job.log);
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }

  return null;
}
