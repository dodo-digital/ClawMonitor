import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { Router } from "express";

import { TTLCache } from "../lib/cache.js";
import { db } from "../lib/db.js";
import { env } from "../lib/env.js";
import { HttpError } from "../lib/errors.js";
import { atomicWriteJsonFile, readJsonFile, resolveSafeTmpLogPath } from "../lib/filesystem.js";
import { asyncHandler, ok } from "../lib/http.js";
import {
  getRegistryRunHistory,
  readCronRegistry,
  writeCronRegistry,
  type RegistryExpects,
  type RegistryFile,
  type RegistryJob,
  type RunEntry,
} from "../monitor/cron-registry.js";
import { runCommand } from "../lib/process.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HealthResult {
  status: "healthy" | "failing" | "disabled" | "unknown";
  details: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cache = new TTLCache<string, unknown>();

async function checkHealth(job: RegistryJob): Promise<HealthResult> {
  if (!job.enabled) return { status: "disabled", details: "-" };

  // OpenClaw layer: check JSONL run history
  if (job.layer === "openclaw" && job.openclaw_id) {
    const runFile = path.join(env.openclawHome, "cron", "runs", `${job.openclaw_id}.jsonl`);
    try {
      const raw = await fs.promises.readFile(runFile, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const last = lines.length > 0 ? (JSON.parse(lines[lines.length - 1]) as RunEntry) : null;
      if (!last) return { status: "unknown", details: "no runs recorded" };
      if (last.status === "ok") {
        return { status: "healthy", details: `last run ok (${new Date(last.ts).toISOString().slice(0, 16)})` };
      }
      return { status: "failing", details: `last status: ${last.status}` };
    } catch {
      return { status: "unknown", details: "no run history file" };
    }
  }

  // Linux layer: check log file
  if (job.log) {
    try {
      const stat = await fs.promises.stat(job.log);
      const raw = await fs.promises.readFile(job.log, "utf8");
      const tail = raw.slice(-4000);
      const issues: string[] = [];

      if (job.expects?.log_contains && !tail.includes(job.expects.log_contains)) {
        issues.push(`missing "${job.expects.log_contains}"`);
      }
      if (job.expects?.log_not_contains && tail.includes(job.expects.log_not_contains)) {
        issues.push(`contains "${job.expects.log_not_contains}"`);
      }

      if (issues.length > 0) {
        return { status: "failing", details: issues.join("; ") };
      }

      const updatedAt = stat.mtime.toISOString().slice(0, 16);
      return { status: "healthy", details: `log updated ${updatedAt}` };
    } catch {
      return { status: "unknown", details: "log file not found" };
    }
  }

  return { status: "unknown", details: "no health check configured" };
}

interface RunStats {
  total: number;
  ok: number;
  errors: number;
  successRate: number; // 0-100
  lastRunAt: number | null;
  lastStatus: string | null;
  lastDurationMs: number | null;
}

async function getRunStats(job: RegistryJob): Promise<RunStats> {
  const runs = await getRunHistory(job, 100);
  if (runs.length === 0) {
    return { total: 0, ok: 0, errors: 0, successRate: -1, lastRunAt: null, lastStatus: null, lastDurationMs: null };
  }
  const ok = runs.filter((r) => r.status === "ok").length;
  const last = runs[0]; // already sorted newest-first
  return {
    total: runs.length,
    ok,
    errors: runs.length - ok,
    successRate: Math.round((ok / runs.length) * 100),
    lastRunAt: last.runAtMs ?? last.ts,
    lastStatus: last.status,
    lastDurationMs: last.durationMs ?? null,
  };
}

async function getRunHistory(job: RegistryJob, limit = 20): Promise<RunEntry[]> {
  return getRegistryRunHistory(job, limit);
}

function parseSystemCrontab(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => !/^[A-Z_][A-Z0-9_]*=/.test(line))
    .map((line) => {
      const parts = line.split(/\s+/);
      const schedule = parts.slice(0, 5).join(" ");
      const command = parts.slice(5).join(" ");
      const logMatch = command.match(/>\s*([^\s]+\.log)/);
      return {
        schedule,
        command,
        logFile: logMatch?.[1] ?? null,
      };
    });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const cronRouter = Router();

// --- Registry endpoints ---

cronRouter.get(
  "/registry",
  asyncHandler(async (req, res) => {
    const includeHealth = req.query.health !== "false";
    const layer = req.query.layer ? String(req.query.layer) : null;
    const category = req.query.category ? String(req.query.category) : null;
    const status = req.query.status ? String(req.query.status) : null;
    const includeArchived = req.query.archived === "true";

    const registry = await readCronRegistry();
    let jobs = registry.jobs;

    if (layer) jobs = jobs.filter((j) => j.layer === layer);
    if (category) jobs = jobs.filter((j) => j.category === category);

    // Cross-reference with jobs.json to get agentId for openclaw jobs
    let ocJobs: OpenClawJob[] = [];
    try {
      const jobsData = await readJobsJson();
      ocJobs = jobsData.jobs;
    } catch { /* no jobs.json */ }

    const results = await Promise.all(
      jobs.map(async (job) => {
        const health = includeHealth ? await checkHealth(job) : null;
        const stats = await getRunStats(job);
        const ocJob = job.openclaw_id ? ocJobs.find((j) => j.id === job.openclaw_id) : null;
        const agentId = ocJob?.agentId ?? (job.layer === "openclaw" ? "direct" : null);
        return { ...job, health, stats, agentId };
      }),
    );

    const filtered = status
      ? results.filter((j) => j.health?.status === status)
      : results;

    const archived = includeArchived ? (registry.archived ?? []) : undefined;

    ok(res, { jobs: filtered, archived });
  }),
);

cronRouter.get(
  "/registry/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const registry = await readCronRegistry();
    const job = registry.jobs.find((j) => j.id === id);
    if (!job) throw new HttpError("Job not found", 404);

    const health = await checkHealth(job);
    const runs = await getRunHistory(job, 100);
    const stats = await getRunStats(job);

    ok(res, { ...job, health, runs, stats });
  }),
);

cronRouter.get(
  "/registry/:id/runs",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
    const registry = await readCronRegistry();
    const job = registry.jobs.find((j) => j.id === id);
    if (!job) throw new HttpError("Job not found", 404);

    const runs = await getRunHistory(job, limit);
    ok(res, { id, runs });
  }),
);

cronRouter.get(
  "/registry/:id/health",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const registry = await readCronRegistry();
    const job = registry.jobs.find((j) => j.id === id);
    if (!job) throw new HttpError("Job not found", 404);

    const health = await checkHealth(job);
    ok(res, { id, ...health });
  }),
);

cronRouter.get(
  "/registry/:id/session",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const registry = await readCronRegistry();
    const job = registry.jobs.find((j) => j.id === id);
    if (!job) throw new HttpError("Job not found", 404);
    if (job.layer !== "openclaw" || !job.openclaw_id) {
      throw new HttpError("Session trace only available for openclaw agent jobs", 400);
    }

    // Find the most recent run to get a session key
    const runs = await getRunHistory(job, 5);
    const lastRun = runs.find((r) => r.sessionKey);

    // Also search the database for cron sessions matching this job
    const cronSessions = db
      .prepare(
        `SELECT DISTINCT ar.run_id, ar.session_key, ar.agent_id, ar.model, ar.started_at, ar.ended_at, ar.duration_ms, ar.status
         FROM agent_runs ar
         WHERE ar.source = 'cron' OR ar.channel LIKE '%cron%'
         ORDER BY ar.started_at DESC
         LIMIT 10`,
      )
      .all() as Array<{
      run_id: string;
      session_key: string;
      agent_id: string;
      model: string;
      started_at: string;
      ended_at: string;
      duration_ms: number;
      status: string;
    }>;

    // For the most recent session, get full trace
    const sessionKey = lastRun?.sessionKey ?? cronSessions[0]?.session_key;
    if (!sessionKey) {
      ok(res, { id, sessions: [], trace: null });
      return;
    }

    const messages = db
      .prepare(
        `SELECT role, content, tokens, cost_total, timestamp
         FROM messages WHERE session_key = @sk ORDER BY timestamp ASC`,
      )
      .all({ sk: sessionKey }) as Array<{
      role: string;
      content: string;
      tokens: number;
      cost_total: number;
      timestamp: string;
    }>;

    const toolCalls = db
      .prepare(
        `SELECT tool_name, input, output, duration_ms, success, timestamp
         FROM tool_calls WHERE session_key = @sk ORDER BY timestamp ASC`,
      )
      .all({ sk: sessionKey }) as Array<{
      tool_name: string;
      input: string;
      output: string;
      duration_ms: number;
      success: number;
      timestamp: string;
    }>;

    ok(res, {
      id,
      sessions: cronSessions,
      trace: {
        session_key: sessionKey,
        messages,
        tool_calls: toolCalls,
      },
    });
  }),
);

cronRouter.put(
  "/registry/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const registry = await readCronRegistry();
    const job = registry.jobs.find((j) => j.id === id);
    if (!job) throw new HttpError("Job not found", 404);

    const body = req.body as Partial<RegistryJob>;

    // Update allowed fields
    if (body.enabled !== undefined) job.enabled = body.enabled;
    if (body.schedule !== undefined) job.schedule = body.schedule;
    if (body.description !== undefined) job.description = body.description;
    if (body.name !== undefined) job.name = body.name;
    if (body.expects !== undefined) job.expects = body.expects;
    if (body.category !== undefined) job.category = body.category;

    // Sync to underlying system
    if (job.layer === "openclaw" && job.openclaw_id && body.enabled !== undefined) {
      const jobsPath = path.join(env.openclawHome, "cron", "jobs.json");
      const jobsFile = await readJsonFile<{ version: number; jobs: Array<Record<string, unknown>> }>(jobsPath);
      const ocJob = jobsFile.jobs.find((entry) => entry.id === job.openclaw_id);
      if (ocJob) {
        ocJob.enabled = job.enabled;
        await atomicWriteJsonFile(jobsPath, jobsFile);
      }
    }

    await writeCronRegistry(registry);
    cache.delete("cron:internal");

    const health = await checkHealth(job);
    ok(res, { ...job, health });
  }),
);

// --- Job config (reads/writes jobs.json directly for prompt editing) ---

type OpenClawJob = {
  id: string;
  agentId?: string;
  name?: string;
  enabled?: boolean;
  sessionTarget?: string;
  wakeMode?: string;
  payload?: {
    kind?: string;
    message?: string;
    text?: string;
    thinking?: string;
    timeoutSeconds?: number;
  };
  delivery?: {
    mode?: string;
    channel?: string;
  };
  state?: Record<string, unknown>;
};

async function readJobsJson(): Promise<{ version: number; jobs: OpenClawJob[] }> {
  const jobsPath = path.join(env.openclawHome, "cron", "jobs.json");
  return readJsonFile<{ version: number; jobs: OpenClawJob[] }>(jobsPath);
}

async function writeJobsJson(data: { version: number; jobs: OpenClawJob[] }): Promise<void> {
  const jobsPath = path.join(env.openclawHome, "cron", "jobs.json");
  await atomicWriteJsonFile(jobsPath, data);
  cache.delete("cron:internal");
}

cronRouter.get(
  "/registry/:id/config",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const registry = await readCronRegistry();
    const registryJob = registry.jobs.find((j) => j.id === id);
    if (!registryJob) throw new HttpError("Job not found", 404);
    if (registryJob.layer !== "openclaw" || !registryJob.openclaw_id) {
      throw new HttpError("Config only available for OpenClaw agent jobs", 400);
    }

    const jobsFile = await readJobsJson();
    const ocJob = jobsFile.jobs.find((j) => j.id === registryJob.openclaw_id);
    if (!ocJob) throw new HttpError("Job not found in jobs.json", 404);

    ok(res, {
      id: registryJob.id,
      openclawId: registryJob.openclaw_id,
      agentId: ocJob.agentId ?? null,
      sessionTarget: ocJob.sessionTarget ?? null,
      wakeMode: ocJob.wakeMode ?? null,
      prompt: ocJob.payload?.message ?? ocJob.payload?.text ?? null,
      payloadKind: ocJob.payload?.kind ?? null,
      thinking: ocJob.payload?.thinking ?? null,
      timeoutSeconds: ocJob.payload?.timeoutSeconds ?? null,
      delivery: ocJob.delivery ?? null,
    });
  }),
);

cronRouter.put(
  "/registry/:id/config",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const registry = await readCronRegistry();
    const registryJob = registry.jobs.find((j) => j.id === id);
    if (!registryJob) throw new HttpError("Job not found", 404);
    if (registryJob.layer !== "openclaw" || !registryJob.openclaw_id) {
      throw new HttpError("Config only available for OpenClaw agent jobs", 400);
    }

    const jobsFile = await readJobsJson();
    const ocJob = jobsFile.jobs.find((j) => j.id === registryJob.openclaw_id);
    if (!ocJob) throw new HttpError("Job not found in jobs.json", 404);

    const body = req.body as { prompt?: string; timeoutSeconds?: number; delivery?: { mode?: string; channel?: string } };

    if (body.prompt !== undefined && ocJob.payload) {
      if (ocJob.payload.kind === "agentTurn") {
        ocJob.payload.message = body.prompt;
      } else {
        ocJob.payload.text = body.prompt;
      }
    }
    if (body.timeoutSeconds !== undefined && ocJob.payload) {
      ocJob.payload.timeoutSeconds = body.timeoutSeconds;
    }
    if (body.delivery !== undefined) {
      ocJob.delivery = body.delivery;
    }

    await writeJobsJson(jobsFile);

    // Also update the command field in registry.yaml to stay in sync
    registryJob.command = body.prompt ?? registryJob.command;
    await writeCronRegistry(registry);

    ok(res, { updated: true });
  }),
);

// --- Run transcript ---

cronRouter.get(
  "/registry/:id/runs/:sessionId/transcript",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const sessionId = String(req.params.sessionId);
    const registry = await readCronRegistry();
    const job = registry.jobs.find((j) => j.id === id);
    if (!job) throw new HttpError("Job not found", 404);

    // The session JSONL lives under the agent's sessions dir
    // Resolve agentId from jobs.json instead of hardcoding "direct"
    let agentId: string | null = null;
    if (job.layer === "openclaw" && job.openclaw_id) {
      try {
        const jobsData = await readJobsJson();
        const ocJob = jobsData.jobs.find((j) => j.id === job.openclaw_id);
        agentId = ocJob?.agentId ?? "direct";
      } catch {
        agentId = "direct";
      }
    }
    if (!agentId) throw new HttpError("Transcripts only available for OpenClaw agent jobs", 400);

    const sessionFile = path.join(env.openclawHome, "agents", agentId, "sessions", `${sessionId}.jsonl`);
    if (!fs.existsSync(sessionFile)) {
      throw new HttpError("Session file not found", 404);
    }

    const items: Array<Record<string, unknown>> = [];
    const lineReader = readline.createInterface({
      input: fs.createReadStream(sessionFile, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lineReader) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "message") {
          const msg = entry.message as { role?: string; content?: unknown; usage?: unknown } | undefined;
          if (!msg) continue;

          const content = msg.content;
          let textContent: string | null = null;
          const toolCalls: unknown[] = [];
          const thinkingBlocks: string[] = [];

          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block !== "object" || !block) continue;
              const b = block as { type?: string; text?: string; name?: string; arguments?: unknown };
              if (b.type === "text") textContent = b.text ?? null;
              if (b.type === "toolCall") toolCalls.push(b);
              if (b.type === "thinking" && b.text) thinkingBlocks.push(b.text);
            }
          } else if (typeof content === "string") {
            textContent = content;
          }

          items.push({
            role: msg.role ?? null,
            content: textContent,
            toolCalls,
            thinkingBlocks,
            tokenUsage: msg.usage ?? null,
            timestamp: entry.timestamp ?? null,
          });
        } else if (entry.type === "session") {
          items.push({
            role: "_session",
            sessionId: entry.id,
            timestamp: entry.timestamp,
            cwd: entry.cwd,
          });
        } else if (entry.type === "model_change") {
          items.push({
            role: "_model",
            provider: entry.provider,
            modelId: entry.modelId,
            timestamp: entry.timestamp,
          });
        }
      } catch {
        // Skip unparseable lines
      }
    }

    ok(res, { jobId: id, sessionId, items });
  }),
);

// --- Legacy endpoints (kept for backwards compatibility) ---

cronRouter.get(
  "/internal",
  asyncHandler(async (_req, res) => {
    const data = await cache.getOrSet(
      "cron:internal",
      async () => {
        const jobsPath = path.join(env.openclawHome, "cron", "jobs.json");
        const jobsFile = await readJsonFile<{ jobs: Array<Record<string, unknown>> }>(jobsPath);
        return jobsFile.jobs.map((job) => ({
          id: job.id,
          name: job.name,
          agentId: job.agentId,
          enabled: job.enabled,
          schedule: job.schedule,
          sessionTarget: job.sessionTarget,
          deliveryMode: (job.delivery as { mode?: string } | undefined)?.mode ?? "default",
          state: job.state ?? null,
        }));
      },
      60_000,
    );
    ok(res, data);
  }),
);

cronRouter.put(
  "/internal/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const jobsPath = path.join(env.openclawHome, "cron", "jobs.json");
    const jobsFile = await readJsonFile<{ version: number; jobs: Array<Record<string, unknown>> }>(jobsPath);
    const job = jobsFile.jobs.find((entry) => entry.id === id);
    if (!job) {
      throw new HttpError("Cron job not found", 404);
    }

    job.enabled = !job.enabled;
    await atomicWriteJsonFile(jobsPath, jobsFile);
    cache.delete("cron:internal");
    ok(res, job);
  }),
);

cronRouter.get(
  "/system",
  asyncHandler(async (_req, res) => {
    const data = await cache.getOrSet(
      "cron:system",
      async () => {
        const { stdout } = await runCommand("crontab", ["-l"]);
        return parseSystemCrontab(stdout);
      },
      60_000,
    );
    ok(res, data);
  }),
);

cronRouter.get(
  "/log/:filename",
  asyncHandler(async (req, res) => {
    const filename = String(req.params.filename);
    const targetPath = await resolveSafeTmpLogPath(filename);

    const { stdout } = await runCommand("tail", ["-n", "100", targetPath]);
    ok(res, {
      filename,
      content: stdout,
    });
  }),
);
