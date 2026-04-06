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
  timezone?: string;
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
  const registry = yaml.load(raw) as RegistryFile;

  // Enrich openclaw jobs with timezone from jobs.json
  try {
    const jobsPath = path.join(env.openclawHome, "cron", "jobs.json");
    const jobsRaw = await fs.promises.readFile(jobsPath, "utf8");
    const jobsData = JSON.parse(jobsRaw);
    const jobs = Array.isArray(jobsData) ? jobsData : (jobsData.jobs ?? Object.values(jobsData));
    const tzMap = new Map<string, string>();
    for (const j of jobs) {
      const tz = j?.schedule?.tz;
      if (j?.id && typeof tz === "string") tzMap.set(j.id, tz);
    }
    for (const job of registry.jobs) {
      if (job.openclaw_id && tzMap.has(job.openclaw_id)) {
        job.timezone = tzMap.get(job.openclaw_id);
      }
    }
  } catch { /* jobs.json missing or unparseable — timezone stays undefined */ }

  return registry;
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

/**
 * Expand a cron field into its discrete values.
 * Handles: wildcards, step values, ranges, lists, and combinations.
 */
function expandFieldValues(field: string, min: number, max: number): Set<number> {
  if (field === "*") {
    const s = new Set<number>();
    for (let i = min; i <= max; i++) s.add(i);
    return s;
  }

  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(?:(\d+)-(\d+)|\*)\/(\d+)$/);
    if (stepMatch) {
      const stepVal = Number(stepMatch[3]);
      if (stepMatch[1] !== undefined) {
        const lo = Number(stepMatch[1]);
        const hi = Number(stepMatch[2]);
        for (let i = lo; i <= hi; i += stepVal) values.add(i);
      } else {
        for (let i = min; i <= max; i += stepVal) values.add(i);
      }
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      for (let i = lo; i <= hi; i++) values.add(i);
      continue;
    }
    const num = Number(part);
    if (Number.isFinite(num)) values.add(num);
  }

  return values;
}

function countFieldValues(field: string, min: number, max: number): number {
  return expandFieldValues(field, min, max).size || 1;
}

/**
 * Check if a cron schedule is currently in an inactive window.
 * Returns true if the schedule restricts hours or days-of-week and
 * the current time falls outside those restrictions.
 * Uses the provided timezone (IANA, e.g. "America/Chicago") or system local time.
 */
export function isScheduleInactive(schedule: string, timezone?: string): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [, hour, , , dayOfWeek] = parts;

  // Resolve current time in the job's timezone
  let nowDay: number;
  let nowHour: number;
  if (timezone) {
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short", hour: "numeric", hour12: false,
      });
      const dateParts = fmt.formatToParts(new Date());
      const hourPart = dateParts.find(p => p.type === "hour");
      const dayPart = dateParts.find(p => p.type === "weekday");
      nowHour = Number(hourPart?.value ?? new Date().getHours());
      const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      nowDay = dayMap[dayPart?.value ?? ""] ?? new Date().getDay();
    } catch {
      // Invalid timezone — fall back to system time
      const now = new Date();
      nowDay = now.getDay();
      nowHour = now.getHours();
    }
  } else {
    const now = new Date();
    nowDay = now.getDay();
    nowHour = now.getHours();
  }

  // Check day-of-week (0=Sunday, 6=Saturday)
  if (dayOfWeek !== "*") {
    const activeDays = expandFieldValues(dayOfWeek, 0, 6);
    if (!activeDays.has(nowDay)) return true;
  }

  // Check hour
  if (hour !== "*" && !hour.includes("/")) {
    const activeHours = expandFieldValues(hour, 0, 23);
    if (!activeHours.has(nowHour)) {
      const maxActive = Math.max(...activeHours);
      const minActive = Math.min(...activeHours);
      // Inactive if outside the active window (with 1-hour buffer after)
      if (nowHour > maxActive + 1 || nowHour < minActive) return true;
    }
  }

  return false;
}

// Estimate the average interval between consecutive firings of a cron schedule.
// Handles step minutes, hour ranges, weekday restrictions, and standard patterns.
export function estimateScheduleIntervalMs(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // --- Sub-hourly: */N in minutes, hours wildcarded ---
  if (minute.startsWith("*/") && hour === "*") {
    const value = Number(minute.slice(2));
    return Number.isFinite(value) && value > 0 ? value * 60_000 : null;
  }

  // --- Sub-hourly with hour range: */N in minute, hour is a range/set ---
  if (minute.startsWith("*/") && hour !== "*") {
    const stepMin = Number(minute.slice(2));
    if (!Number.isFinite(stepMin) || stepMin <= 0) return null;
    // Fires stepMin-minute apart during those hours
    return stepMin * 60_000;
  }

  // --- Specific minute(s), all hours → hourly ---
  if (minute !== "*" && !minute.includes("/") && hour === "*" && dayOfMonth === "*" && month === "*") {
    const minuteCount = countFieldValues(minute, 0, 59);
    return Math.round((60 / minuteCount) * 60_000);
  }

  // --- Specific minute, hour range/set → fires once per hour in that range ---
  // e.g. "0 9-18 * * *" or "0 9-18 * * 1-5"
  if (minute !== "*" && !minute.includes("/") && hour !== "*" && !hour.includes("/") && dayOfMonth === "*" && month === "*") {
    const hourCount = countFieldValues(hour, 0, 23);
    const minuteCount = countFieldValues(minute, 0, 59);
    const firesPerDay = hourCount * minuteCount;
    if (firesPerDay <= 0) return null;

    if (firesPerDay === 1) {
      // Fires once per active day. If day-of-week is restricted to a single day, it's weekly.
      const activeDays = dayOfWeek === "*" ? 7 : countFieldValues(dayOfWeek, 0, 6);
      if (activeDays === 1) return 7 * 24 * 60 * 60_000;
      return 24 * 60 * 60_000;
    }
    // Multiple fires per day: the gap between consecutive fires within the active window.
    // For "0 9-18" that's 10 fires with 60-min gaps; for "0,30 9-18" that's 20 fires
    // with 30-min gaps. Use hourSpan / (firesPerDay - 1) as the typical gap, but
    // floor to hourSpan/firesPerDay to stay conservative for uneven distributions.
    if (minuteCount === 1 && hourCount > 1) {
      // Simple case: one fire per hour → interval = 60 min
      return 60 * 60_000;
    }
    // Multiple minutes per hour within hour range
    return Math.round((60 * 60_000) / minuteCount);
  }

  // --- Step hours: */N in hour field ---
  if (hour.startsWith("*/")) {
    const stepHr = Number(hour.slice(2));
    return Number.isFinite(stepHr) && stepHr > 0 ? stepHr * 60 * 60_000 : null;
  }

  // --- Fallbacks for broader patterns ---

  // All wildcard hours → hourly
  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return 60 * 60_000;
  }

  // Specific hour(s), day wildcards → daily
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return 24 * 60 * 60_000;
  }

  // Day-of-week restriction with daily schedule → daily (during active days)
  if (dayOfMonth === "*" && month === "*" && dayOfWeek !== "*") {
    const hourCount = countFieldValues(hour, 0, 23);
    if (hourCount <= 1) return 24 * 60 * 60_000;
    return Math.round((24 * 60 * 60_000) / hourCount);
  }

  // Monthly
  if (dayOfMonth !== "*" && month === "*") {
    return 31 * 24 * 60 * 60_000;
  }

  return null;
}

/**
 * Get timestamps of recent runs for frequency analysis.
 * Returns timestamps in chronological order (oldest first).
 */
export async function getRecentRunTimestamps(job: RegistryJob, limit = 20): Promise<number[]> {
  const runs = await getRegistryRunHistory(job, limit);
  // runs are in reverse chronological order from getRegistryRunHistory
  return runs
    .map((r) => r.runAtMs ?? r.ts)
    .filter((t) => t > 0)
    .reverse(); // chronological
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
