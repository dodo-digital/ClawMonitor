import { Router } from "express";
import { db } from "../lib/db.js";
import { asyncHandler, ok } from "../lib/http.js";

export const analyticsRouter = Router();

function stripUserMessageWrapper(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.includes("(untrusted metadata)")) return raw;
  const stripped = raw
    .replace(/(?:Conversation info|Sender)\s*\(untrusted metadata\):\s*```json\s*\{[^`]*\}\s*```/gs, "")
    .trim();
  return stripped || null;
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractMemorySearchMetrics(output: string | null): { resultCount: number | null; scores: number[] } {
  const parsed = parseJson(output);
  if (Array.isArray(parsed)) {
    return {
      resultCount: parsed.length,
      scores: parsed
        .map((item) => (typeof item === "object" && item !== null ? (item as { score?: unknown }).score : null))
        .filter((score): score is number => typeof score === "number"),
    };
  }

  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of ["results", "matches", "items", "data"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        return {
          resultCount: value.length,
          scores: value
            .map((item) => (typeof item === "object" && item !== null ? (item as { score?: unknown }).score : null))
            .filter((score): score is number => typeof score === "number"),
        };
      }
    }
  }

  return { resultCount: null, scores: [] };
}

function extractMemorySearchQuery(input: string | null): string | null {
  const parsed = parseJson(input);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  for (const key of ["query", "q", "text", "search"]) {
    if (typeof record[key] === "string") {
      return record[key] as string;
    }
  }
  return null;
}

// Recent agent runs
analyticsRouter.get(
  "/runs",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const agent = req.query.agent ? String(req.query.agent) : null;
    const channel = req.query.channel ? String(req.query.channel) : null;
    const source = req.query.source ? String(req.query.source) : null;

    let where = "WHERE 1=1";
    const params: Record<string, unknown> = {};

    if (agent) { where += " AND agent_id = @agent"; params.agent = agent; }
    if (channel) { where += " AND channel = @channel"; params.channel = channel; }
    if (source) { where += " AND source = @source"; params.source = source; }

    const runs = db.prepare(`
      SELECT run_id, session_key, agent_id, channel, channel_name, source, model,
             started_at, ended_at, duration_ms, status
      FROM agent_runs ${where}
      ORDER BY started_at DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });

    const total = db.prepare(`SELECT COUNT(*) as count FROM agent_runs ${where}`).get(params) as { count: number };

    ok(res, { items: runs, total: total.count, limit, offset });
  }),
);

// Recent messages
analyticsRouter.get(
  "/messages",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const sessionKey = req.query.session_key ? String(req.query.session_key) : null;
    const role = req.query.role ? String(req.query.role) : null;
    const search = req.query.search ? String(req.query.search) : null;

    let where = "WHERE 1=1";
    const params: Record<string, unknown> = {};

    if (sessionKey) { where += " AND session_key = @session_key"; params.session_key = sessionKey; }
    if (role) { where += " AND role = @role"; params.role = role; }
    if (search) { where += " AND content LIKE @search"; params.search = `%${search}%`; }

    const messages = db.prepare(`
      SELECT id, run_id, session_key, agent_id, role, content, channel, channel_name, source, tokens, timestamp
      FROM messages ${where}
      ORDER BY timestamp DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });

    const total = db.prepare(`SELECT COUNT(*) as count FROM messages ${where}`).get(params) as { count: number };

    ok(res, { items: messages, total: total.count, limit, offset });
  }),
);

// Tool call analytics
analyticsRouter.get(
  "/tool-calls",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const days = Math.min(Math.max(Number(req.query.days ?? 7), 1), 90);

    const calls = db.prepare(`
      SELECT tool_name, COUNT(*) as count,
             SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
             SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
             AVG(duration_ms) as avg_duration_ms,
             MAX(timestamp) as last_used
      FROM tool_calls
      WHERE timestamp > datetime('now', '-' || @days || ' days')
      GROUP BY tool_name
      ORDER BY count DESC
      LIMIT @limit
    `).all({ days, limit });

    ok(res, { items: calls, days });
  }),
);

analyticsRouter.get(
  "/memory-searches",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 200), 1), 1000);
    const days = Math.min(Math.max(Number(req.query.days ?? 30), 1), 365);

    const rows = db.prepare(`
      WITH ranked AS (
        SELECT id, session_key, agent_id, tool_call_id, tool_name, input, output, channel, source, success, timestamp,
               ROW_NUMBER() OVER (
                 PARTITION BY session_key, timestamp, tool_name, COALESCE(input, '')
                 ORDER BY CASE WHEN tool_call_id IS NOT NULL THEN 0 ELSE 1 END, id DESC
               ) AS row_rank
        FROM tool_calls
        WHERE timestamp > datetime('now', '-' || @days || ' days')
          AND (
            LOWER(tool_name) = 'memory_search'
            OR LOWER(tool_name) = 'memory-search'
            OR LOWER(tool_name) = 'memorysearch'
            OR LOWER(tool_name) = 'qmd_search'
            OR LOWER(tool_name) LIKE '%memory%search%'
          )
      )
      SELECT id, session_key, agent_id, tool_call_id, tool_name, input, output, channel, source, success, timestamp
      FROM ranked
      WHERE row_rank = 1
      ORDER BY timestamp DESC
      LIMIT @limit
    `).all({ days, limit }) as Array<{
      id: number;
      session_key: string;
      agent_id: string;
      tool_call_id: string | null;
      tool_name: string;
      input: string | null;
      output: string | null;
      channel: string;
      source: string;
      success: number | null;
      timestamp: string;
    }>;

    const items = rows.map((row) => {
      const metrics = extractMemorySearchMetrics(row.output);
      return {
        id: row.id,
        sessionKey: row.session_key,
        agentId: row.agent_id,
        toolCallId: row.tool_call_id,
        toolName: row.tool_name,
        query: extractMemorySearchQuery(row.input),
        resultCount: metrics.resultCount,
        scores: metrics.scores,
        success: row.success,
        channel: row.channel,
        source: row.source,
        timestamp: row.timestamp,
      };
    });

    ok(res, { items, limit, days });
  }),
);

// Skill usage analytics
analyticsRouter.get(
  "/skill-usage",
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 30), 1), 90);

    const usage = db.prepare(`
      SELECT skill_name, COUNT(*) as count,
             COUNT(DISTINCT session_key) as unique_sessions,
             COUNT(DISTINCT channel) as unique_channels,
             MAX(timestamp) as last_triggered,
             GROUP_CONCAT(DISTINCT source) as sources
      FROM skill_triggers
      WHERE timestamp > datetime('now', '-' || @days || ' days')
      GROUP BY skill_name
      ORDER BY count DESC
    `).all({ days });

    ok(res, { items: usage, days });
  }),
);

// Sessions from DB (faster than JSONL scanning)
analyticsRouter.get(
  "/sessions",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const agent = req.query.agent ? String(req.query.agent) : null;
    const channel = req.query.channel ? String(req.query.channel) : null;
    const source = req.query.source ? String(req.query.source) : null;

    let where = "WHERE 1=1";
    const params: Record<string, unknown> = {};

    if (agent) { where += " AND agent_id = @agent"; params.agent = agent; }
    if (channel) { where += " AND channel = @channel"; params.channel = channel; }
    if (source) { where += " AND source = @source"; params.source = source; }

    const sessions = db.prepare(`
      SELECT session_key, agent_id, channel, channel_name, source, runtime_type,
             created_at, updated_at, message_count, total_tokens
      FROM sessions ${where}
      ORDER BY updated_at DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });

    const total = db.prepare(`SELECT COUNT(*) as count FROM sessions ${where}`).get(params) as { count: number };

    ok(res, { items: sessions, total: total.count, limit, offset });
  }),
);

// Dashboard summary stats
analyticsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const agent = req.query.agent ? String(req.query.agent) : null;
    const af = agent ? " AND agent_id = @agent" : ""; // agent filter fragment
    const ap = agent ? { agent } : {}; // agent params

    const last24h = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agent_runs WHERE started_at > datetime('now', '-1 day')${af}) as runs_24h,
        (SELECT COUNT(*) FROM messages WHERE timestamp > datetime('now', '-1 day')${af}) as messages_24h,
        (SELECT COUNT(DISTINCT session_key) FROM agent_runs WHERE started_at > datetime('now', '-1 day')${af}) as active_sessions_24h,
        (SELECT COUNT(*) FROM tool_calls WHERE timestamp > datetime('now', '-1 day')${af}) as tool_calls_24h,
        (SELECT COUNT(*) FROM skill_triggers WHERE timestamp > datetime('now', '-1 day')${af}) as skill_triggers_24h
    `).get(ap) as Record<string, number>;

    const byChannel = db.prepare(`
      SELECT channel, source, COUNT(*) as runs
      FROM agent_runs
      WHERE started_at > datetime('now', '-1 day')${af}
      GROUP BY channel, source
      ORDER BY runs DESC
    `).all(ap);

    const byAgent = db.prepare(`
      SELECT agent_id, COUNT(*) as runs
      FROM agent_runs
      WHERE started_at > datetime('now', '-1 day')${af}
      GROUP BY agent_id
      ORDER BY runs DESC
    `).all(ap);

    const recentRuns = db.prepare(`
      SELECT
        r.run_id, r.session_key, r.agent_id, r.channel, r.channel_name, r.source,
        r.started_at, r.ended_at, r.duration_ms,
        (
          SELECT SUBSTR(m.content, 1, 1000)
          FROM messages m
          WHERE m.session_key = r.session_key
            AND m.timestamp >= r.started_at
            AND (r.ended_at IS NULL OR m.timestamp <= r.ended_at)
            AND m.role = 'user' AND m.content IS NOT NULL AND m.content != ''
          ORDER BY m.timestamp ASC
          LIMIT 1
        ) as first_user_message
      FROM agent_runs r
      ${agent ? "WHERE r.agent_id = @agent" : ""}
      ORDER BY r.started_at DESC
      LIMIT 10
    `).all(ap) as Array<Record<string, unknown>>;

    // Strip metadata wrappers from user message previews
    for (const run of recentRuns) {
      run.first_user_message = stripUserMessageWrapper(run.first_user_message as string | null);
    }

    const totalWhere = agent ? " WHERE agent_id = @agent" : "";
    ok(res, {
      last24h,
      byChannel,
      byAgent,
      recentRuns,
      totalSessions: (db.prepare(`SELECT COUNT(*) as count FROM sessions${totalWhere}`).get(ap) as { count: number }).count,
      totalMessages: (db.prepare(`SELECT COUNT(*) as count FROM messages${totalWhere}`).get(ap) as { count: number }).count,
      totalEvents: (db.prepare(`SELECT COUNT(*) as count FROM events${totalWhere}`).get(ap) as { count: number }).count,
    });
  }),
);

analyticsRouter.get(
  "/costs",
  asyncHandler(async (req, res) => {
    const agent = req.query.agent ? String(req.query.agent) : null;
    const af = agent ? " AND agent_id = @agent" : "";
    const ap = agent ? { agent } : {};

    const summary = db.prepare(`
      SELECT
        ROUND(COALESCE(SUM(cost_total), 0), 6) as total_cost,
        ROUND(COALESCE(SUM(CASE WHEN timestamp > datetime('now', '-1 day') THEN cost_total ELSE 0 END), 0), 6) as cost_24h,
        ROUND(COALESCE(SUM(CASE WHEN timestamp > datetime('now', '-7 days') THEN cost_total ELSE 0 END), 0), 6) as cost_7d,
        COUNT(*) as assistant_messages,
        SUM(CASE WHEN cost_total IS NOT NULL THEN 1 ELSE 0 END) as priced_messages
      FROM messages
      WHERE role = 'assistant'${af}
    `).get(ap) as Record<string, number>;

    const byAgent = db.prepare(`
      SELECT agent_id,
             ROUND(COALESCE(SUM(cost_total), 0), 6) as total_cost,
             COUNT(*) as assistant_messages
      FROM messages
      WHERE role = 'assistant'${af}
      GROUP BY agent_id
      ORDER BY total_cost DESC, assistant_messages DESC
    `).all(ap);

    const byDay = db.prepare(`
      SELECT substr(timestamp, 1, 10) as day,
             ROUND(COALESCE(SUM(cost_total), 0), 6) as total_cost,
             COUNT(*) as assistant_messages
      FROM messages
      WHERE role = 'assistant'${af}
      GROUP BY substr(timestamp, 1, 10)
      ORDER BY day DESC
      LIMIT 30
    `).all(ap);

    ok(res, { summary, byAgent, byDay });
  }),
);
