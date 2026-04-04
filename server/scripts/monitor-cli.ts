#!/usr/bin/env tsx
/**
 * monitor-cli — Query Claw Monitor's SQLite database directly.
 * No server needed. Designed for AI agents and human operators.
 *
 * Usage: npx tsx server/scripts/monitor-cli.ts <command> [options]
 */

import path from "node:path";
import Database from "better-sqlite3";

// ── Find the database ──────────────────────────────────────────

function findDatabase(): string {
  const explicit = process.env.CLAWMONITOR_DB;
  if (explicit) return explicit;

  const home = process.env.OPENCLAW_HOME ?? path.join(process.env.HOME ?? "/root", ".openclaw");
  return path.join(home, "dashboard.sqlite");
}

function openDb(): Database.Database {
  const dbPath = findDatabase();
  try {
    const db = new Database(dbPath, { readonly: true });
    db.pragma("journal_mode = WAL");
    return db;
  } catch (err: any) {
    console.error(`ERROR: Cannot open database at ${dbPath}`);
    console.error(err.message);
    process.exit(1);
  }
}

// ── Output helpers ─────────────────────────────────────────────

const jsonMode = process.argv.includes("--json");

function printTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log("(no results)");
    return;
  }
  if (jsonMode) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length))
  );

  // Cap column widths at 60 to keep tables readable
  const cappedWidths = widths.map((w) => Math.min(w, 60));

  const header = keys.map((k, i) => k.toUpperCase().padEnd(cappedWidths[i])).join("  ");
  const sep = cappedWidths.map((w) => "-".repeat(w)).join("  ");

  console.log(header);
  console.log(sep);
  for (const row of rows) {
    const line = keys.map((k, i) => {
      const val = String(row[k] ?? "");
      return val.slice(0, cappedWidths[i]).padEnd(cappedWidths[i]);
    }).join("  ");
    console.log(line);
  }
  console.log(`\n${rows.length} row(s)`);
}

function printDetail(obj: Record<string, unknown>): void {
  if (jsonMode) {
    console.log(JSON.stringify(obj, null, 2));
    return;
  }
  const maxKey = Math.max(...Object.keys(obj).map((k) => k.length));
  for (const [k, v] of Object.entries(obj)) {
    const val = typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "..." : String(v ?? "");
    console.log(`${k.padEnd(maxKey)}  ${val}`);
  }
}

function ago(isoDate: string | null): string {
  if (!isoDate) return "";
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.round(ms / 3600_000)}h ago`;
  return `${Math.round(ms / 86400_000)}d ago`;
}

// ── Commands ───────────────────────────────────────────────────

function cmdStatus(db: Database.Database): void {
  const incidents = db.prepare(`
    SELECT status, COUNT(*) as count FROM incidents GROUP BY status
  `).all() as Array<{ status: string; count: number }>;

  const recentChecks = db.prepare(`
    SELECT status, COUNT(*) as count FROM check_results
    WHERE observed_at > datetime('now', '-1 hour')
    GROUP BY status
  `).all() as Array<{ status: string; count: number }>;

  const lastCheck = db.prepare(`
    SELECT MAX(observed_at) as last FROM check_results
  `).get() as { last: string | null };

  const sessions24h = db.prepare(`
    SELECT COUNT(*) as count FROM sessions WHERE updated_at > datetime('now', '-1 day')
  `).get() as { count: number };

  const runs24h = db.prepare(`
    SELECT COUNT(*) as count FROM agent_runs WHERE started_at > datetime('now', '-1 day')
  `).get() as { count: number };

  const failingTools = db.prepare(`
    SELECT COUNT(*) as count FROM tool_calls
    WHERE success = 0 AND timestamp > datetime('now', '-1 hour')
  `).get() as { count: number };

  if (jsonMode) {
    console.log(JSON.stringify({ incidents, recentChecks, lastCheck: lastCheck.last, sessions24h: sessions24h.count, runs24h: runs24h.count, failingTools1h: failingTools.count }, null, 2));
    return;
  }

  console.log("=== Claw Monitor Status ===\n");

  console.log("Incidents:");
  if (incidents.length === 0) {
    console.log("  (none)");
  } else {
    for (const i of incidents) console.log(`  ${i.status}: ${i.count}`);
  }

  console.log("\nHealth checks (last hour):");
  if (recentChecks.length === 0) {
    console.log("  (no checks in last hour)");
  } else {
    for (const c of recentChecks) console.log(`  ${c.status}: ${c.count}`);
  }
  if (lastCheck.last) console.log(`  Last check: ${lastCheck.last} (${ago(lastCheck.last)})`);

  console.log(`\nActivity (24h):`);
  console.log(`  Sessions: ${sessions24h.count}`);
  console.log(`  Runs: ${runs24h.count}`);
  console.log(`  Failed tool calls (1h): ${failingTools.count}`);
}

function cmdIncidents(db: Database.Database, args: string[]): void {
  let statusFilter = "";
  const idx = args.indexOf("--status");
  if (idx !== -1 && args[idx + 1]) {
    statusFilter = args[idx + 1];
  }

  let query = `
    SELECT id, status, severity, check_type, target_key, title,
           opened_at, last_seen_at, resolved_at,
           (SELECT COUNT(*) FROM incident_events WHERE incident_id = incidents.id) as event_count
    FROM incidents
  `;
  if (statusFilter) {
    query += ` WHERE status = '${statusFilter.replace(/'/g, "")}'`;
  }
  query += ` ORDER BY opened_at DESC LIMIT 50`;

  const rows = db.prepare(query).all() as Record<string, unknown>[];

  // Add human-readable age
  const enriched = rows.map((r) => ({
    id: r.id,
    status: r.status,
    severity: r.severity,
    check_type: r.check_type,
    title: r.title,
    opened: ago(r.opened_at as string),
    last_seen: ago(r.last_seen_at as string),
    events: r.event_count,
  }));

  printTable(enriched);
}

function cmdIncidentDetail(db: Database.Database, id: string): void {
  const incident = db.prepare(`
    SELECT * FROM incidents WHERE id = ?
  `).get(Number(id)) as Record<string, unknown> | undefined;

  if (!incident) {
    console.error(`Incident ${id} not found`);
    process.exit(1);
  }

  console.log("=== Incident Detail ===\n");
  printDetail(incident);

  const events = db.prepare(`
    SELECT id, event_type, created_at, actor_user_id,
           substr(payload_json, 1, 200) as payload_preview
    FROM incident_events
    WHERE incident_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(Number(id)) as Record<string, unknown>[];

  if (events.length > 0) {
    console.log("\n--- Events ---");
    printTable(events);
  }

  const deliveries = db.prepare(`
    SELECT id, event_type, destination_name, success, status_code, error_message, created_at
    FROM notification_deliveries
    WHERE incident_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(Number(id)) as Record<string, unknown>[];

  if (deliveries.length > 0) {
    console.log("\n--- Notification Deliveries ---");
    printTable(deliveries);
  }
}

function cmdChecks(db: Database.Database, args: string[]): void {
  let checkType = "";
  const idx = args.indexOf("--type");
  if (idx !== -1 && args[idx + 1]) {
    checkType = args[idx + 1];
  }

  // Get the latest check result per (check_type, target_key)
  let query = `
    SELECT cr.check_type, cr.target_key, cr.status, cr.severity, cr.summary, cr.observed_at
    FROM check_results cr
    INNER JOIN (
      SELECT check_type, target_key, MAX(observed_at) as max_at
      FROM check_results
      GROUP BY check_type, target_key
    ) latest ON cr.check_type = latest.check_type
      AND cr.target_key = latest.target_key
      AND cr.observed_at = latest.max_at
  `;
  if (checkType) {
    query += ` WHERE cr.check_type LIKE '%${checkType.replace(/'/g, "")}%'`;
  }
  query += ` ORDER BY cr.check_type, cr.target_key`;

  const rows = db.prepare(query).all() as Record<string, unknown>[];

  const enriched = rows.map((r) => ({
    check_type: r.check_type,
    target: r.target_key,
    status: r.status,
    severity: r.severity,
    summary: (r.summary as string).slice(0, 80),
    observed: ago(r.observed_at as string),
  }));

  printTable(enriched);
}

function cmdSessions(db: Database.Database, args: string[]): void {
  const limit = getNumArg(args, "--limit", 20);
  const agentFilter = getStrArg(args, "--agent");

  let query = `
    SELECT session_key, agent_id, channel, source, message_count, total_tokens,
           created_at, updated_at
    FROM sessions
  `;
  if (agentFilter) {
    query += ` WHERE agent_id LIKE '%${agentFilter.replace(/'/g, "")}%'`;
  }
  query += ` ORDER BY updated_at DESC LIMIT ${limit}`;

  const rows = db.prepare(query).all() as Record<string, unknown>[];

  const enriched = rows.map((r) => ({
    session_key: (r.session_key as string).slice(0, 20),
    agent: r.agent_id,
    channel: r.channel,
    source: r.source,
    msgs: r.message_count,
    tokens: r.total_tokens,
    updated: ago(r.updated_at as string),
  }));

  printTable(enriched);
}

function cmdRuns(db: Database.Database, args: string[]): void {
  const limit = getNumArg(args, "--limit", 20);
  const sessionKey = getStrArg(args, "--session");

  let query = `
    SELECT run_id, session_key, agent_id, model, status, started_at, duration_ms
    FROM agent_runs
  `;
  if (sessionKey) {
    query += ` WHERE session_key LIKE '%${sessionKey.replace(/'/g, "")}%'`;
  }
  query += ` ORDER BY started_at DESC LIMIT ${limit}`;

  const rows = db.prepare(query).all() as Record<string, unknown>[];

  const enriched = rows.map((r) => ({
    run_id: (r.run_id as string).slice(0, 16),
    agent: r.agent_id,
    model: r.model,
    status: r.status,
    started: ago(r.started_at as string),
    duration: r.duration_ms ? `${Math.round((r.duration_ms as number) / 1000)}s` : "running",
  }));

  printTable(enriched);
}

function cmdTools(db: Database.Database, args: string[]): void {
  const limit = getNumArg(args, "--limit", 30);
  const nameFilter = getStrArg(args, "--name");
  const failedOnly = args.includes("--failed");

  let query = `
    SELECT tool_name, session_key, agent_id, success, duration_ms, timestamp,
           substr(input, 1, 100) as input_preview
    FROM tool_calls
  `;
  const conditions: string[] = [];
  if (nameFilter) conditions.push(`tool_name LIKE '%${nameFilter.replace(/'/g, "")}%'`);
  if (failedOnly) conditions.push(`success = 0`);
  if (conditions.length) query += ` WHERE ${conditions.join(" AND ")}`;
  query += ` ORDER BY timestamp DESC LIMIT ${limit}`;

  const rows = db.prepare(query).all() as Record<string, unknown>[];

  const enriched = rows.map((r) => ({
    tool: r.tool_name,
    ok: r.success ? "yes" : "FAIL",
    agent: r.agent_id,
    duration: r.duration_ms ? `${r.duration_ms}ms` : "",
    when: ago(r.timestamp as string),
    input: (r.input_preview as string || "").slice(0, 50),
  }));

  printTable(enriched);
}

function cmdRunDetail(db: Database.Database, runId: string): void {
  const run = db.prepare(`
    SELECT * FROM agent_runs WHERE run_id LIKE ?
  `).get(`${runId}%`) as Record<string, unknown> | undefined;

  if (!run) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }

  console.log("=== Run Detail ===\n");
  printDetail(run);

  // Try run_id first, fall back to session_key + time window
  let messages = db.prepare(`
    SELECT id, role, substr(content, 1, 120) as content_preview, tokens, timestamp
    FROM messages
    WHERE run_id = ?
    ORDER BY timestamp ASC
  `).all(run.run_id as string) as Record<string, unknown>[];

  if (messages.length === 0) {
    messages = db.prepare(`
      SELECT id, role, substr(content, 1, 120) as content_preview, tokens, timestamp
      FROM messages
      WHERE session_key = ? AND timestamp >= ? AND timestamp <= COALESCE(?, datetime('now'))
      ORDER BY timestamp ASC
    `).all(run.session_key as string, run.started_at as string, run.ended_at as string | null) as Record<string, unknown>[];
  }

  if (messages.length > 0) {
    console.log(`\n--- Messages (${messages.length}) ---`);
    printTable(messages);
  }

  let tools = db.prepare(`
    SELECT tool_name, success, duration_ms, timestamp,
           substr(input, 1, 80) as input_preview
    FROM tool_calls
    WHERE run_id = ?
    ORDER BY timestamp ASC
  `).all(run.run_id as string) as Record<string, unknown>[];

  if (tools.length === 0) {
    tools = db.prepare(`
      SELECT tool_name, success, duration_ms, timestamp,
             substr(input, 1, 80) as input_preview
      FROM tool_calls
      WHERE session_key = ? AND timestamp >= ? AND timestamp <= COALESCE(?, datetime('now'))
      ORDER BY timestamp ASC
    `).all(run.session_key as string, run.started_at as string, run.ended_at as string | null) as Record<string, unknown>[];
  }

  if (tools.length > 0) {
    console.log(`\n--- Tool Calls (${tools.length}) ---`);
    printTable(tools);
  }
}

function cmdSearch(db: Database.Database, args: string[]): void {
  const query = args.filter((a, i, arr) => !a.startsWith("--") && (i === 0 || !arr[i - 1].startsWith("--"))).join(" ");
  if (!query) {
    console.error("Usage: monitor search <keywords>");
    process.exit(1);
  }

  const limit = getNumArg(args, "--limit", 10);

  // Check if FTS5 table exists, fall back to LIKE if not
  const hasFts = (db.prepare(`SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='messages_fts'`).get() as { c: number }).c > 0;

  let rows: Record<string, unknown>[];

  if (hasFts) {
    // Use FTS5 for fast ranked search
    const ftsQuery = query.split(/\s+/).map((w) => `"${w}"`).join(" ");
    rows = db.prepare(`
      SELECT
        s.session_key,
        s.agent_id,
        s.channel,
        s.source,
        s.message_count,
        s.total_tokens,
        s.created_at,
        s.updated_at,
        (SELECT COUNT(*) FROM tool_calls WHERE session_key = s.session_key) as tool_count,
        (SELECT snippet(messages_fts, 0, '', '', '...', 30) FROM messages_fts
         WHERE messages_fts MATCH ? AND session_key = s.session_key
         LIMIT 1) as matching_snippet,
        (SELECT run_id FROM agent_runs WHERE session_key = s.session_key
         ORDER BY started_at DESC LIMIT 1) as latest_run_id
      FROM sessions s
      WHERE s.session_key IN (
        SELECT DISTINCT session_key FROM messages_fts WHERE messages_fts MATCH ?
      )
      ORDER BY s.updated_at DESC
      LIMIT ?
    `).all(ftsQuery, ftsQuery, limit) as Record<string, unknown>[];
  } else {
    // Fallback to LIKE for databases without FTS
    const pattern = `%${query}%`;
    rows = db.prepare(`
      SELECT
        s.session_key,
        s.agent_id,
        s.channel,
        s.source,
        s.message_count,
        s.total_tokens,
        s.created_at,
        s.updated_at,
        (SELECT COUNT(*) FROM tool_calls WHERE session_key = s.session_key) as tool_count,
        (SELECT substr(content, 1, 150) FROM messages
         WHERE session_key = s.session_key AND content LIKE ?
         ORDER BY timestamp ASC LIMIT 1) as matching_snippet,
        (SELECT run_id FROM agent_runs WHERE session_key = s.session_key
         ORDER BY started_at DESC LIMIT 1) as latest_run_id
      FROM sessions s
      WHERE s.session_key IN (
        SELECT DISTINCT session_key FROM messages WHERE content LIKE ?
      )
      ORDER BY s.updated_at DESC
      LIMIT ?
    `).all(pattern, pattern, limit) as Record<string, unknown>[];
  }

  if (rows.length === 0) {
    console.log(`No conversations found matching "${query}"`);
    return;
  }

  if (jsonMode) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`Found ${rows.length} conversation(s) matching "${query}":\n`);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const snippet = (r.matching_snippet as string || "").replace(/\n/g, " ").slice(0, 100);
    const id = r.latest_run_id ? (r.latest_run_id as string).slice(0, 8) : (r.session_key as string).slice(0, 12);
    console.log(`  ${i + 1}. [${id}] ${ago(r.updated_at as string)} — ${r.agent_id}, ${r.message_count} msgs, ${r.tool_count} tools`);
    console.log(`     "${snippet}..."`);
    console.log();
  }

  const firstId = rows[0].latest_run_id
    ? (rows[0].latest_run_id as string).slice(0, 8)
    : (rows[0].session_key as string).slice(0, 12);
  console.log(`To resume: monitor resume ${firstId}`);
}

function cmdResume(db: Database.Database, id: string): void {
  // Try run_id first, then session_key
  let run = db.prepare(`SELECT * FROM agent_runs WHERE run_id LIKE ?`).get(`${id}%`) as Record<string, unknown> | undefined;
  let sessionKey: string;

  if (run) {
    sessionKey = run.session_key as string;
  } else {
    // Try as session_key
    const session = db.prepare(`SELECT * FROM sessions WHERE session_key LIKE ?`).get(`${id}%`) as Record<string, unknown> | undefined;
    if (!session) {
      console.error(`No run or session found matching: ${id}`);
      process.exit(1);
    }
    sessionKey = session.session_key as string;
    // Get the latest run for this session if one exists
    run = db.prepare(`SELECT * FROM agent_runs WHERE session_key = ? ORDER BY started_at DESC LIMIT 1`).get(sessionKey) as Record<string, unknown> | undefined;
  }

  const messages = db.prepare(`
    SELECT role, content, tokens, timestamp
    FROM messages
    WHERE session_key = ?
    ORDER BY timestamp ASC
  `).all(sessionKey) as Array<{ role: string; content: string | null; tokens: number | null; timestamp: string }>;

  const tools = db.prepare(`
    SELECT tool_name, input, output, success, duration_ms, timestamp
    FROM tool_calls
    WHERE session_key = ?
    ORDER BY timestamp ASC
  `).all(sessionKey) as Array<{
    tool_name: string; input: string | null; output: string | null;
    success: number | null; duration_ms: number | null; timestamp: string;
  }>;

  if (jsonMode) {
    console.log(JSON.stringify({ run, sessionKey, messages, tools }, null, 2));
    return;
  }

  // Output as context that an agent can consume
  const agentId = run?.agent_id ?? "unknown";
  const model = run?.model ?? "";
  const started = (run?.started_at ?? messages[0]?.timestamp ?? "unknown") as string;
  const duration = run?.duration_ms ? `${Math.round((run.duration_ms as number) / 1000)}s` : "unknown";

  console.log(`# Previous Conversation Context`);
  console.log();
  console.log(`This is a continuation of a previous session. Here's what happened:`);
  console.log();
  console.log(`- **Agent:** ${agentId}${model ? ` (${model})` : ""}`);
  console.log(`- **When:** ${started} (${ago(started)})`);
  console.log(`- **Duration:** ${duration}`);
  console.log(`- **Messages:** ${messages.length}, **Tool calls:** ${tools.length}`);
  console.log();

  // Print conversation
  console.log(`## Conversation`);
  console.log();
  for (const msg of messages) {
    const content = msg.content || "(empty)";
    // Truncate very long messages but keep enough to be useful
    const trimmed = content.length > 2000 ? content.slice(0, 2000) + "\n...(truncated)" : content;
    console.log(`**[${msg.role}]**`);
    console.log(trimmed);
    console.log();
  }

  // Print tool calls if any
  if (tools.length > 0) {
    console.log(`## Tool Calls`);
    console.log();
    for (const t of tools) {
      const status = t.success ? "success" : "FAILED";
      const dur = t.duration_ms ? ` (${t.duration_ms}ms)` : "";
      const input = t.input ? t.input.slice(0, 200) : "";
      console.log(`- **${t.tool_name}** → ${status}${dur}`);
      if (input) console.log(`  Input: \`${input}\``);
      console.log();
    }
  }

  console.log(`---`);
  console.log(`Pick up where this left off. The user wants to continue this work.`);
}

function cmdQuery(db: Database.Database, args: string[]): void {
  const sql = args.join(" ");
  if (!sql) {
    console.error("Usage: monitor-cli query <SQL>");
    process.exit(1);
  }

  // Safety: only allow SELECT
  if (!/^\s*SELECT/i.test(sql)) {
    console.error("ERROR: Only SELECT queries are allowed");
    process.exit(1);
  }

  const rows = db.prepare(sql).all() as Record<string, unknown>[];
  printTable(rows);
}

function cmdTranscript(db: Database.Database, runId: string): void {
  const run = db.prepare(`
    SELECT * FROM agent_runs WHERE run_id LIKE ?
  `).get(`${runId}%`) as Record<string, unknown> | undefined;

  if (!run) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }

  // Get messages: try run_id first, fall back to session_key + time window
  let messages = db.prepare(`
    SELECT role, content, tokens, timestamp
    FROM messages
    WHERE run_id = ?
    ORDER BY timestamp ASC
  `).all(run.run_id as string) as Array<{ role: string; content: string | null; tokens: number | null; timestamp: string }>;

  if (messages.length === 0) {
    messages = db.prepare(`
      SELECT role, content, tokens, timestamp
      FROM messages
      WHERE session_key = ? AND timestamp >= ? AND timestamp <= COALESCE(?, datetime('now'))
      ORDER BY timestamp ASC
    `).all(run.session_key as string, run.started_at as string, run.ended_at as string | null) as Array<{ role: string; content: string | null; tokens: number | null; timestamp: string }>;
  }

  if (jsonMode) {
    console.log(JSON.stringify({ run, messages }, null, 2));
    return;
  }

  const duration = run.duration_ms ? `${Math.round((run.duration_ms as number) / 1000)}s` : "running";
  console.log(`=== Transcript: ${(run.run_id as string).slice(0, 16)} ===`);
  console.log(`Session: ${run.session_key}`);
  console.log(`Duration: ${run.started_at} → ${run.ended_at || "(running)"} (${duration})`);
  console.log(`Messages: ${messages.length}`);
  console.log();

  for (const msg of messages) {
    const content = msg.content || "(empty)";
    // Cap tool results to keep output readable
    const maxLen = msg.role === "toolResult" ? 500 : 3000;
    const trimmed = content.length > maxLen ? content.slice(0, maxLen) + "\n...(truncated)" : content;
    console.log(`[${msg.role}] ${msg.timestamp}`);
    console.log(trimmed);
    console.log();
  }

  if (messages.length === 0) {
    console.log("(no messages found — JSONL may not have been ingested yet)");
  }
}

function cmdDelivery(db: Database.Database, args: string[]): void {
  const jobOrRunId = args.filter((a) => !a.startsWith("--"))[0] || null;
  const limit = getNumArg(args, "--limit", 10);

  let rows: Record<string, unknown>[];

  if (jobOrRunId) {
    rows = db.prepare(`
      SELECT job_id, status, delivery_status, duration_ms, model,
             input_tokens, output_tokens, total_tokens,
             substr(summary, 1, 200) as summary_preview,
             timestamp
      FROM cron_deliveries
      WHERE job_id LIKE ? OR run_id LIKE ? OR session_id LIKE ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(`${jobOrRunId}%`, `${jobOrRunId}%`, `${jobOrRunId}%`, limit) as Record<string, unknown>[];
  } else {
    rows = db.prepare(`
      SELECT job_id, status, delivery_status, duration_ms, model,
             input_tokens, output_tokens, total_tokens,
             substr(summary, 1, 200) as summary_preview,
             timestamp
      FROM cron_deliveries
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
  }

  if (jsonMode) {
    // For JSON mode, get full summaries
    const fullRows = jobOrRunId
      ? db.prepare(`SELECT * FROM cron_deliveries WHERE job_id LIKE ? OR run_id LIKE ? ORDER BY timestamp DESC LIMIT ?`)
          .all(`${jobOrRunId}%`, `${jobOrRunId}%`, limit)
      : db.prepare(`SELECT * FROM cron_deliveries ORDER BY timestamp DESC LIMIT ?`).all(limit);
    console.log(JSON.stringify(fullRows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(jobOrRunId ? `No deliveries found for: ${jobOrRunId}` : "No deliveries found (cron_deliveries table is empty — will populate on next cron run)");
    return;
  }

  const enriched = rows.map((r) => ({
    job: r.job_id,
    status: r.status,
    delivered: r.delivery_status || "—",
    duration: r.duration_ms ? `${Math.round((r.duration_ms as number) / 1000)}s` : "—",
    model: r.model || "—",
    tokens: r.total_tokens || "—",
    when: ago(r.timestamp as string),
    summary: ((r.summary_preview as string) || "").replace(/\n/g, " ").slice(0, 80),
  }));

  printTable(enriched);
}

function cmdTables(db: Database.Database): void {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
  `).all() as Array<{ name: string }>;

  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t.name})`).all() as Array<{ name: string; type: string; notnull: number }>;
    const count = (db.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).get() as { c: number }).c;
    console.log(`\n${t.name} (${count} rows)`);
    for (const c of cols) {
      console.log(`  ${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}`);
    }
  }
}

// ── Arg helpers ────────────────────────────────────────────────

function getStrArg(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

function getNumArg(args: string[], flag: string, defaultVal: number): number {
  const val = getStrArg(args, flag);
  return val ? Number(val) : defaultVal;
}

// ── Main ───────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`monitor-cli — Query Claw Monitor's SQLite database directly

Usage: npx tsx server/scripts/monitor-cli.ts <command> [options]

Commands:
  status                      Overview: incidents, checks, activity counts
  incidents [--status <s>]    List incidents (filter: open, acknowledged, resolved)
  incident <id>               Full incident detail with events and deliveries
  checks [--type <t>]         Latest check result per check type
  sessions [--agent <a>] [--limit N]    Recent sessions
  runs [--session <key>] [--limit N]    Recent agent runs
  run <run_id>                Full run detail: messages, tool calls
  tools [--name <n>] [--failed] [--limit N]    Recent tool calls
  search <keywords>            Find conversations by keyword
  transcript <run_id>         Full conversation transcript for a run
  delivery [job_id] [--limit N]  Cron delivery history (what was sent)
  resume <run_id>             Output conversation context for continuation
  tables                      Show all tables and their schemas
  query <SQL>                 Run a read-only SQL query directly

Global options:
  --json                      Output as JSON instead of tables

Environment:
  CLAWMONITOR_DB              Path to database (default: $OPENCLAW_HOME/dashboard.sqlite)
  OPENCLAW_HOME               OpenClaw home directory (default: ~/.openclaw)`);
}

const args = process.argv.slice(2).filter((a) => a !== "--json");
const command = args[0];
const commandArgs = args.slice(1);

if (!command || command === "help" || command === "--help" || command === "-h") {
  printUsage();
  process.exit(0);
}

const db = openDb();

try {
  switch (command) {
    case "status":
      cmdStatus(db);
      break;
    case "incidents":
      cmdIncidents(db, commandArgs);
      break;
    case "incident":
      if (!commandArgs[0]) { console.error("Usage: monitor-cli incident <id>"); process.exit(1); }
      cmdIncidentDetail(db, commandArgs[0]);
      break;
    case "checks":
      cmdChecks(db, commandArgs);
      break;
    case "sessions":
      cmdSessions(db, commandArgs);
      break;
    case "runs":
      cmdRuns(db, commandArgs);
      break;
    case "run":
      if (!commandArgs[0]) { console.error("Usage: monitor-cli run <run_id>"); process.exit(1); }
      cmdRunDetail(db, commandArgs[0]);
      break;
    case "tools":
      cmdTools(db, commandArgs);
      break;
    case "search":
      cmdSearch(db, commandArgs);
      break;
    case "transcript":
      if (!commandArgs[0]) { console.error("Usage: monitor transcript <run_id>"); process.exit(1); }
      cmdTranscript(db, commandArgs[0]);
      break;
    case "delivery":
    case "deliveries":
      cmdDelivery(db, commandArgs);
      break;
    case "resume":
      if (!commandArgs[0]) { console.error("Usage: monitor-cli resume <run_id>"); process.exit(1); }
      cmdResume(db, commandArgs[0]);
      break;
    case "tables":
      cmdTables(db);
      break;
    case "query":
      cmdQuery(db, commandArgs);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
} finally {
  db.close();
}
