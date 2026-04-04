import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { Router } from "express";

import { TTLCache } from "../lib/cache.js";
import { db } from "../lib/db.js";
import { env } from "../lib/env.js";
import { HttpError } from "../lib/errors.js";
import { readJsonFile } from "../lib/filesystem.js";
import { asyncHandler, ok } from "../lib/http.js";

/**
 * Strip OpenClaw's Telegram/Slack metadata wrapper from user messages.
 * Returns just the actual user text.
 */
function stripUserMessageWrapper(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.includes("(untrusted metadata)")) return raw;

  const stripped = raw
    .replace(/(?:Conversation info|Sender)\s*\(untrusted metadata\):\s*```json\s*\{[^`]*\}\s*```/gs, "")
    .trim();

  return stripped || null;
}

type SessionIndexEntry = {
  sessionId: string;
  updatedAt?: number;
  sessionFile?: string;
};

type SessionListing = {
  sessionId: string;
  agentId: string;
  sessionKey: string;
  channel: string;
  displayName: string;
  category: "conversation" | "cron" | "system";
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  totalCost: number;
  toolCallCount: number;
  lastUserMessage: string | null;
  durationMs: number | null;
  runCount: number;
};

const cache = new TTLCache<string, SessionListing[]>();

function parseSessionLine(line: string): { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } } | null {
  try {
    return JSON.parse(line) as { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
  } catch {
    return null;
  }
}

function extractMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (typeof part === "object" && part && "text" in part) {
        return String((part as { text?: string }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");

  return text || null;
}

function deriveChannel(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts[2] === "main") {
    return "main";
  }
  if (parts.includes("telegram")) {
    return "telegram";
  }
  if (parts.includes("webchat")) {
    return "webchat";
  }
  if (parts.includes("slack")) {
    return "slack";
  }
  if (parts.includes("cron")) {
    return "cron";
  }
  if (parts.includes("hook")) {
    return "hook";
  }
  if (parts.includes("binding")) {
    return parts[3] ?? "binding";
  }
  return "unknown";
}

// Known cron job name mappings (loaded from jobs.json on first call)
let cronJobNames: Map<string, string> | null = null;

function loadCronJobNames(): Map<string, string> {
  if (cronJobNames) return cronJobNames;
  cronJobNames = new Map();
  try {
    const jobsPath = path.join(env.openclawHome, "cron", "jobs.json");
    const data = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
    const jobs = data.jobs ?? data;
    if (Array.isArray(jobs)) {
      for (const job of jobs) {
        if (job.id && job.name) {
          cronJobNames.set(job.id, job.name);
        }
      }
    }
  } catch {
    // jobs.json not found or unparseable
  }
  return cronJobNames;
}

/**
 * Generate a human-readable display name and category from a session key.
 */
function deriveDisplayInfo(sessionKey: string): { displayName: string; category: "conversation" | "cron" | "system" } {
  const parts = sessionKey.split(":");
  // parts[0] = "agent", parts[1] = agentId, parts[2+] = channel info

  const agentId = parts[1] ?? "unknown";

  // Main control UI session
  if (parts[2] === "main") {
    return { displayName: "Control UI", category: "conversation" };
  }

  // Telegram sessions
  if (parts.includes("telegram")) {
    const topicIdx = parts.indexOf("topic");
    if (topicIdx !== -1 && parts[topicIdx + 1]) {
      const topicId = parts[topicIdx + 1];
      const topicNames: Record<string, string> = {
        "1": "General",
        "4": "Claude Code",
        "205": "Goal Tracker",
        "421": "Codex / Paperclip",
        "494": "Claude / Dodo Digital",
      };
      const topicName = topicNames[topicId] ?? `Topic ${topicId}`;
      return { displayName: `Telegram — ${topicName}`, category: "conversation" };
    }
    if (parts.includes("slash")) {
      return { displayName: "Telegram — Slash Command", category: "conversation" };
    }
    return { displayName: "Telegram", category: "conversation" };
  }

  // Slack sessions
  if (parts.includes("slack")) {
    if (parts.includes("thread")) {
      return { displayName: "Slack — Thread", category: "conversation" };
    }
    return { displayName: "Slack", category: "conversation" };
  }

  // Cron sessions
  if (parts.includes("cron")) {
    const cronNames = loadCronJobNames();
    // Try to find the cron job ID in the session key
    // Format: agent:direct:cron:<job-id> or agent:direct:cron:<job-id>:run:<run-id>
    const cronIdx = parts.indexOf("cron");
    const jobId = parts[cronIdx + 1] ?? "";

    // Skip sub-run sessions (cron:jobid:run:runid)
    const runIdx = parts.indexOf("run");

    const jobName = cronNames.get(jobId) ?? null;
    if (jobName) {
      const suffix = runIdx !== -1 ? " (run)" : "";
      return { displayName: jobName + suffix, category: "cron" };
    }
    // Use the job ID itself — only truncate if it looks like a UUID
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(jobId);
    const displayId = isUuid ? jobId.slice(0, 8) + "…" : jobId;
    const suffix = runIdx !== -1 ? " (run)" : "";
    return { displayName: `Cron — ${displayId}${suffix}`, category: "cron" };
  }

  // Paperclip
  if (parts.includes("paperclip")) {
    return { displayName: "Paperclip", category: "system" };
  }

  // OpenAI / ACP sessions
  if (parts.includes("openai")) {
    const sessionUuid = parts[parts.length - 1] ?? "";
    const shortId = sessionUuid.slice(0, 8);
    return { displayName: `OpenAI Session ${shortId}`, category: "conversation" };
  }

  // ACP binding sessions
  if (parts.includes("binding")) {
    return { displayName: `ACP — ${agentId}`, category: "conversation" };
  }

  // Webhook / hook sessions
  if (parts.includes("hook")) {
    return { displayName: "Webhook", category: "system" };
  }

  return { displayName: sessionKey, category: "conversation" };
}

async function countMessagesAndCreatedAt(sessionFile: string): Promise<{ count: number; createdAt: string | null }> {
  let count = 0;
  let createdAt: string | null = null;
  const stream = fs.createReadStream(sessionFile, { encoding: "utf8" });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lineReader) {
    if (!line.trim()) {
      continue;
    }
    const parsed = parseSessionLine(line);
    if (!parsed) {
      continue;
    }
    if (!createdAt && parsed.timestamp) {
      createdAt = parsed.timestamp;
    }
    if (parsed.type === "message") {
      count += 1;
    }
  }

  return { count, createdAt };
}

async function loadSessionListings(): Promise<SessionListing[]> {
  // DB-backed session listing — all sessions come from the sessions table,
  // enriched with aggregated cost, tool, and run data via joins.
  const rows = db.prepare(`
    SELECT
      s.session_key,
      s.agent_id,
      s.channel,
      s.channel_name,
      s.source,
      s.runtime_type,
      s.created_at,
      s.updated_at,
      s.message_count,
      s.total_tokens,
      ROUND(COALESCE((
        SELECT SUM(m.cost_total) FROM messages m WHERE m.session_key = s.session_key
      ), 0), 6) as total_cost,
      COALESCE((
        SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_key = s.session_key
      ), 0) as tool_call_count,
      COALESCE((
        SELECT COUNT(*) FROM agent_runs r WHERE r.session_key = s.session_key
      ), 0) as run_count,
      (
        SELECT MIN(r2.started_at) FROM agent_runs r2 WHERE r2.session_key = s.session_key
      ) as first_run,
      (
        SELECT MAX(COALESCE(r3.ended_at, r3.started_at)) FROM agent_runs r3 WHERE r3.session_key = s.session_key
      ) as last_run,
      (
        SELECT SUBSTR(m2.content, 1, 1000)
        FROM messages m2
        WHERE m2.session_key = s.session_key
          AND m2.role = 'user'
          AND m2.content IS NOT NULL
          AND m2.content != ''
        ORDER BY m2.timestamp DESC
        LIMIT 1
      ) as last_user_message
    FROM sessions s
    ORDER BY s.updated_at DESC
  `).all() as Array<{
    session_key: string;
    agent_id: string;
    channel: string;
    channel_name: string | null;
    source: string;
    runtime_type: string;
    created_at: string;
    updated_at: string;
    message_count: number;
    total_tokens: number;
    total_cost: number;
    tool_call_count: number;
    run_count: number;
    first_run: string | null;
    last_run: string | null;
    last_user_message: string | null;
  }>;

  return rows.map((row) => {
    let durationMs: number | null = null;
    if (row.first_run && row.last_run) {
      durationMs = Date.parse(row.last_run) - Date.parse(row.first_run);
    }

    const { displayName, category } = deriveDisplayInfo(row.session_key);

    return {
      sessionId: row.session_key,
      agentId: row.agent_id,
      sessionKey: row.session_key,
      channel: row.channel,
      displayName,
      category,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
      totalCost: row.total_cost,
      toolCallCount: row.tool_call_count,
      lastUserMessage: stripUserMessageWrapper(row.last_user_message),
      durationMs,
      runCount: row.run_count,
    };
  });
}

/**
 * Resolve a sessionId (from URL params) to a JSONL file path.
 * Accepts either: a UUID sessionId (legacy) or a full session_key.
 */
async function findSessionFile(agentId: string, sessionId: string): Promise<string> {
  const indexPath = path.join(env.openclawHome, "agents", agentId, "sessions", "sessions.json");
  if (!fs.existsSync(indexPath)) {
    throw new HttpError("Agent session index not found", 404);
  }

  const index = await readJsonFile<Record<string, SessionIndexEntry>>(indexPath);

  // Try as session_key first (DB-backed listing uses session_key as sessionId)
  const directEntry = index[sessionId];
  if (directEntry?.sessionFile && fs.existsSync(directEntry.sessionFile)) {
    return directEntry.sessionFile;
  }

  // Fall back to UUID lookup (legacy JSONL index)
  const entry = Object.values(index).find((item) => item.sessionId === sessionId);
  if (!entry?.sessionFile || !fs.existsSync(entry.sessionFile)) {
    throw new HttpError("Session file not found", 404);
  }

  return entry.sessionFile;
}

/**
 * Resolve a sessionId (from URL params) to a session_key.
 * Accepts either: a UUID sessionId (legacy) or a full session_key.
 */
async function findSessionKey(agentId: string, sessionId: string): Promise<string> {
  // If it looks like a session_key (contains colons), use it directly
  if (sessionId.includes(":")) {
    return sessionId;
  }

  // Legacy UUID lookup
  const indexPath = path.join(env.openclawHome, "agents", agentId, "sessions", "sessions.json");
  if (!fs.existsSync(indexPath)) {
    throw new HttpError("Agent session index not found", 404);
  }
  const index = await readJsonFile<Record<string, SessionIndexEntry>>(indexPath);
  for (const [sessionKey, entry] of Object.entries(index)) {
    if (entry.sessionId === sessionId) return sessionKey;
  }
  throw new HttpError("Session not found", 404);
}

export const sessionsRouter = Router();

sessionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const allSessions = await cache.getOrSet("session:listings", () => loadSessionListings(), 60_000);
    const page = Math.max(Number(req.query.page ?? 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const from = req.query.from ? Date.parse(String(req.query.from)) : null;
    const to = req.query.to ? Date.parse(String(req.query.to)) : null;

    const filtered = allSessions.filter((session) => {
      if (req.query.agent && session.agentId !== String(req.query.agent)) {
        return false;
      }
      if (req.query.channel && session.channel !== String(req.query.channel)) {
        return false;
      }
      const updatedAtMs = session.updatedAt ? Date.parse(session.updatedAt) : null;
      if (from && updatedAtMs && updatedAtMs < from) {
        return false;
      }
      if (to && updatedAtMs && updatedAtMs > to) {
        return false;
      }
      return true;
    });

    const start = (page - 1) * limit;
    ok(res, {
      items: filtered.slice(start, start + limit),
      total: filtered.length,
      page,
      limit,
    });
  }),
);

/**
 * GET /api/sessions/:agentId/:sessionId/runs
 * List all agent runs within a session, with per-run stats.
 */
sessionsRouter.get(
  "/:agentId/:sessionId/runs",
  asyncHandler(async (req, res) => {
    const sessionKey = await findSessionKey(String(req.params.agentId), String(req.params.sessionId));

    const runs = db.prepare(`
      SELECT
        r.run_id,
        r.session_key,
        r.agent_id,
        r.channel,
        r.model,
        r.started_at,
        r.ended_at,
        r.duration_ms,
        r.status,
        ROUND(COALESCE((
          SELECT SUM(m.cost_total) FROM messages m
          WHERE m.session_key = r.session_key
            AND m.timestamp >= r.started_at
            AND (r.ended_at IS NULL OR m.timestamp <= r.ended_at)
        ), 0), 6) as total_cost,
        COALESCE((
          SELECT COUNT(*) FROM messages m
          WHERE m.session_key = r.session_key
            AND m.timestamp >= r.started_at
            AND (r.ended_at IS NULL OR m.timestamp <= r.ended_at)
        ), 0) as message_count,
        COALESCE((
          SELECT COUNT(*) FROM tool_calls tc
          WHERE tc.session_key = r.session_key
            AND tc.timestamp >= r.started_at
            AND (r.ended_at IS NULL OR tc.timestamp <= r.ended_at)
        ), 0) as tool_call_count,
        (
          SELECT SUBSTR(m2.content, 1, 1000)
          FROM messages m2
          WHERE m2.session_key = r.session_key
            AND m2.timestamp >= r.started_at
            AND (r.ended_at IS NULL OR m2.timestamp <= r.ended_at)
            AND m2.role = 'user'
            AND m2.content IS NOT NULL AND m2.content != ''
          ORDER BY m2.timestamp ASC
          LIMIT 1
        ) as first_user_message
      FROM agent_runs r
      WHERE r.session_key = ?
      ORDER BY r.started_at DESC
    `).all(sessionKey) as Array<{
      run_id: string;
      session_key: string;
      agent_id: string;
      channel: string;
      model: string | null;
      started_at: string;
      ended_at: string | null;
      duration_ms: number | null;
      status: string;
      total_cost: number;
      message_count: number;
      tool_call_count: number;
      first_user_message: string | null;
    }>;

    // Strip metadata wrappers from user message previews
    for (const run of runs) {
      run.first_user_message = stripUserMessageWrapper(run.first_user_message);
    }

    ok(res, { runs });
  }),
);

sessionsRouter.get(
  "/:agentId/:sessionId",
  asyncHandler(async (req, res) => {
    // TODO: Deep offsets still require a linear scan through the JSONL file.
    // Add a byte-offset index if transcript pagination becomes a hotspot.
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
    const messagesOnly = req.query.messagesOnly === "true";
    const sessionFile = await findSessionFile(String(req.params.agentId), String(req.params.sessionId));

    const items: Array<Record<string, unknown>> = [];
    let index = 0;
    let hasMore = false;
    const lineReader = readline.createInterface({
      input: fs.createReadStream(sessionFile, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    const MESSAGE_TYPES = new Set(["message"]);

    for await (const line of lineReader) {
      if (!line.trim()) {
        continue;
      }

      const parsedLine = parseSessionLine(line);
      if (!parsedLine) {
        continue;
      }
      if (messagesOnly && !MESSAGE_TYPES.has(parsedLine.type as string)) {
        continue;
      }

      if (index >= offset && items.length < limit) {
        const message = (parsedLine.message ?? {}) as {
          role?: string;
          content?: unknown;
        };
        const content = extractMessageContent(message.content);
        const toolCalls = Array.isArray(message.content)
          ? message.content.filter(
              (part) => typeof part === "object" && part && (part as { type?: string }).type === "toolCall",
            )
          : [];
        items.push({
          type: parsedLine.type ?? null,
          role: message.role ?? null,
          content,
          timestamp: parsedLine.timestamp ?? null,
          toolCalls,
          tokenUsage: (parsedLine.message as { usage?: unknown } | undefined)?.usage ?? null,
        });
      } else if (index >= offset && items.length >= limit) {
        hasMore = true;
        break;
      }

      index += 1;
    }

    ok(res, {
      items,
      offset,
      limit,
      hasMore,
    });
  }),
);

/**
 * GET /api/sessions/entry/:entryId
 * Fetch full message content by JSONL entry_id. Used by the live feed
 * to load full content on expand without sending it all over WebSocket.
 */
sessionsRouter.get(
  "/entry/:entryId",
  asyncHandler(async (req, res) => {
    const { entryId } = req.params;
    if (!entryId || entryId.length > 64) {
      throw new HttpError("Invalid entry ID", 400);
    }

    const row = db
      .prepare(
        `SELECT entry_id, role, content, agent_id, channel, session_key, tokens, cost_total, timestamp
         FROM messages WHERE entry_id = ? LIMIT 1`,
      )
      .get(entryId) as
      | { entry_id: string; role: string; content: string; agent_id: string; channel: string; session_key: string; tokens: number | null; cost_total: number | null; timestamp: string }
      | undefined;

    if (!row) {
      // Try tool_calls table
      const toolRow = db
        .prepare(
          `SELECT tool_call_id, tool_name, input, output, agent_id, channel, session_key, duration_ms, success, timestamp
           FROM tool_calls WHERE tool_call_id = ? LIMIT 1`,
        )
        .get(entryId) as
        | { tool_call_id: string; tool_name: string; input: string | null; output: string | null; agent_id: string; channel: string; session_key: string; duration_ms: number | null; success: number | null; timestamp: string }
        | undefined;

      if (!toolRow) {
        throw new HttpError("Entry not found", 404);
      }

      ok(res, {
        type: "tool_call",
        entryId: toolRow.tool_call_id,
        toolName: toolRow.tool_name,
        input: toolRow.input,
        output: toolRow.output,
        agentId: toolRow.agent_id,
        channel: toolRow.channel,
        sessionKey: toolRow.session_key,
        durationMs: toolRow.duration_ms,
        success: toolRow.success,
        timestamp: toolRow.timestamp,
      });
      return;
    }

    ok(res, {
      type: "message",
      entryId: row.entry_id,
      role: row.role,
      content: row.content,
      agentId: row.agent_id,
      channel: row.channel,
      sessionKey: row.session_key,
      tokens: row.tokens,
      costTotal: row.cost_total,
      timestamp: row.timestamp,
    });
  }),
);
