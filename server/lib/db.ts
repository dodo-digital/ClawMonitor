import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { BOOTSTRAP_FILES } from "./constants.js";

type DashboardDatabase = Database.Database;

export type DashboardStatements = {
  upsertSession: Database.Statement;
  insertRun: Database.Statement;
  endRun: Database.Statement;
  insertMessage: Database.Statement;
  incrementSessionMetrics: Database.Statement;
  insertToolCall: Database.Statement;
  updateToolCallResult: Database.Statement;
  insertSkillTrigger: Database.Statement;
  insertEvent: Database.Statement;
  cleanOldEvents: Database.Statement;
  insertCronDelivery: Database.Statement;
  backfillRunIdMessages: Database.Statement;
  backfillRunIdToolCalls: Database.Statement;
  insertIdentityVersion: Database.Statement;
  countIdentityVersions: Database.Statement;
  countIdentityVersionsByFile: Database.Statement;
  listIdentityVersionsByFile: Database.Statement;
  getIdentityVersionByFileAndId: Database.Statement;
  updateIdentityVersionLabel: Database.Statement;
};

export type IdentityVersionRecord = {
  id: number;
  file_name: string;
  content: string;
  char_count: number;
  label: string | null;
  created_at: string;
};

export type IdentityVersionSummary = Omit<IdentityVersionRecord, "content">;

export let db!: DashboardDatabase;
export let stmts!: DashboardStatements;

function hasColumn(database: DashboardDatabase, table: string, column: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

function ensureColumn(database: DashboardDatabase, table: string, definition: string): void {
  const columnName = definition.trim().split(/\s+/)[0];
  if (!hasColumn(database, table, columnName)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function createStatements(database: DashboardDatabase): DashboardStatements {
  return {
    upsertSession: database.prepare(`
      INSERT INTO sessions (session_key, agent_id, channel, channel_name, source, runtime_type, updated_at)
      VALUES (@session_key, @agent_id, @channel, @channel_name, @source, @runtime_type, datetime('now'))
      ON CONFLICT(session_key) DO UPDATE SET
        updated_at = datetime('now'),
        channel_name = COALESCE(@channel_name, sessions.channel_name),
        source = CASE WHEN @source != 'unknown' THEN @source ELSE sessions.source END
    `),

    insertRun: database.prepare(`
      INSERT OR IGNORE INTO agent_runs (run_id, session_key, agent_id, channel, channel_name, source, model, started_at, status)
      VALUES (@run_id, @session_key, @agent_id, @channel, @channel_name, @source, @model, @started_at, 'running')
    `),

    endRun: database.prepare(`
      UPDATE agent_runs SET ended_at = @ended_at, duration_ms = @duration_ms, status = 'completed'
      WHERE run_id = @run_id
    `),

    insertMessage: database.prepare(`
      INSERT OR IGNORE INTO messages (
        entry_id, run_id, session_key, agent_id, role, content, channel, channel_name, source, tokens, cost_total, timestamp
      )
      VALUES (
        @entry_id, @run_id, @session_key, @agent_id, @role, @content, @channel, @channel_name, @source, @tokens, @cost_total, @timestamp
      )
    `),

    incrementSessionMetrics: database.prepare(`
      UPDATE sessions
      SET message_count = message_count + @message_increment,
          total_tokens = total_tokens + @token_increment,
          updated_at = datetime('now')
      WHERE session_key = @session_key
    `),

    insertToolCall: database.prepare(`
      INSERT OR IGNORE INTO tool_calls (
        tool_call_id, run_id, session_key, agent_id, tool_name, input, output, channel, source, duration_ms, success, timestamp
      )
      VALUES (
        @tool_call_id, @run_id, @session_key, @agent_id, @tool_name, @input, @output, @channel, @source, @duration_ms, @success, @timestamp
      )
    `),

    updateToolCallResult: database.prepare(`
      UPDATE tool_calls
      SET output = @output, success = @success
      WHERE session_key = @session_key
        AND tool_call_id = @tool_call_id
    `),

    insertSkillTrigger: database.prepare(`
      INSERT INTO skill_triggers (skill_name, agent_id, session_key, channel, channel_name, source, timestamp)
      VALUES (@skill_name, @agent_id, @session_key, @channel, @channel_name, @source, @timestamp)
    `),

    insertEvent: database.prepare(`
      INSERT INTO events (type, event, agent_id, run_id, session_key, channel, channel_name, source, payload, timestamp)
      VALUES (@type, @event, @agent_id, @run_id, @session_key, @channel, @channel_name, @source, @payload, @timestamp)
    `),

    cleanOldEvents: database.prepare(`
      DELETE FROM events WHERE timestamp < datetime('now', '-7 days')
    `),

    insertCronDelivery: database.prepare(`
      INSERT INTO cron_deliveries (
        job_id, run_id, session_key, session_id, status, delivery_status,
        summary, duration_ms, model, provider, input_tokens, output_tokens, total_tokens, timestamp
      )
      VALUES (
        @job_id, @run_id, @session_key, @session_id, @status, @delivery_status,
        @summary, @duration_ms, @model, @provider, @input_tokens, @output_tokens, @total_tokens, @timestamp
      )
    `),

    backfillRunIdMessages: database.prepare(`
      UPDATE messages SET run_id = (
        SELECT ar.run_id FROM agent_runs ar
        WHERE ar.session_key = messages.session_key
          AND messages.timestamp >= ar.started_at
          AND (ar.ended_at IS NULL OR messages.timestamp <= ar.ended_at)
        ORDER BY ar.started_at DESC LIMIT 1
      )
      WHERE messages.session_key = @session_key
        AND messages.run_id IS NULL
    `),

    backfillRunIdToolCalls: database.prepare(`
      UPDATE tool_calls SET run_id = (
        SELECT ar.run_id FROM agent_runs ar
        WHERE ar.session_key = tool_calls.session_key
          AND tool_calls.timestamp >= ar.started_at
          AND (ar.ended_at IS NULL OR tool_calls.timestamp <= ar.ended_at)
        ORDER BY ar.started_at DESC LIMIT 1
      )
      WHERE tool_calls.session_key = @session_key
        AND tool_calls.run_id IS NULL
    `),

    insertIdentityVersion: database.prepare(`
      INSERT INTO identity_versions (file_name, content, char_count, label)
      VALUES (@file_name, @content, @char_count, @label)
    `),

    countIdentityVersions: database.prepare(`
      SELECT COUNT(*) AS count
      FROM identity_versions
    `),

    countIdentityVersionsByFile: database.prepare(`
      SELECT file_name, COUNT(*) AS count
      FROM identity_versions
      GROUP BY file_name
    `),

    listIdentityVersionsByFile: database.prepare(`
      SELECT id, file_name, char_count, label, created_at
      FROM identity_versions
      WHERE file_name = @file_name
      ORDER BY created_at DESC, id DESC
      LIMIT @limit
    `),

    getIdentityVersionByFileAndId: database.prepare(`
      SELECT id, file_name, content, char_count, label, created_at
      FROM identity_versions
      WHERE file_name = @file_name AND id = @id
    `),

    updateIdentityVersionLabel: database.prepare(`
      UPDATE identity_versions
      SET label = @label
      WHERE file_name = @file_name AND id = @id
    `),
  };
}

export function initializeDatabase(dbPath: string): { db: DashboardDatabase; stmts: DashboardStatements } {
  if (typeof db !== "undefined") {
    db.close();
  }

  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("foreign_keys = ON");

  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT UNIQUE NOT NULL,
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      channel_name TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      runtime_type TEXT NOT NULL DEFAULT 'native',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      message_count INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT UNIQUE NOT NULL,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      channel_name TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      model TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT,
      run_id TEXT,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      channel TEXT NOT NULL,
      channel_name TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      tokens INTEGER,
      cost_total REAL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_call_id TEXT,
      run_id TEXT,
      session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input TEXT,
      output TEXT,
      channel TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'unknown',
      duration_ms INTEGER,
      success INTEGER,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS skill_triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      channel_name TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      event TEXT,
      agent_id TEXT,
      run_id TEXT,
      session_key TEXT,
      channel TEXT,
      channel_name TEXT,
      source TEXT,
      payload TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS identity_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      content TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cron_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      run_id TEXT,
      session_key TEXT,
      session_id TEXT,
      status TEXT NOT NULL,
      delivery_status TEXT,
      summary TEXT,
      duration_ms INTEGER,
      model TEXT,
      provider TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS check_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      check_type TEXT NOT NULL,
      target_key TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      check_type TEXT NOT NULL,
      target_key TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      acknowledged_at TEXT,
      resolved_at TEXT,
      last_seen_at TEXT NOT NULL,
      acknowledged_by_user_id TEXT,
      resolution_note TEXT
    );

    CREATE TABLE IF NOT EXISTS incident_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      actor_user_id TEXT,
      FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER,
      event_type TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      destination_name TEXT NOT NULL,
      success INTEGER NOT NULL,
      status_code INTEGER,
      response_body TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
    );
  `);

  ensureColumn(database, "messages", "entry_id TEXT");
  ensureColumn(database, "messages", "cost_total REAL");
  ensureColumn(database, "tool_calls", "tool_call_id TEXT");

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel);
    CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_runs_session ON agent_runs(session_key);
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON agent_runs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_runs_started ON agent_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_channel ON agent_runs(channel);

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key);
    CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);
    CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_entry_id
      ON messages(session_key, entry_id)
      WHERE entry_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_tools_run ON tool_calls(run_id);
    CREATE INDEX IF NOT EXISTS idx_tools_name ON tool_calls(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tools_timestamp ON tool_calls(timestamp DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_session_tool_call_id
      ON tool_calls(session_key, tool_call_id)
      WHERE tool_call_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_skills_name ON skill_triggers(skill_name);
    CREATE INDEX IF NOT EXISTS idx_skills_timestamp ON skill_triggers(timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, event);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_key);

    CREATE INDEX IF NOT EXISTS idx_versions_file ON identity_versions(file_name, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_check_results_lookup
      ON check_results(workspace_id, check_type, target_key, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_check_results_dedupe
      ON check_results(workspace_id, dedupe_key, observed_at DESC);

    CREATE INDEX IF NOT EXISTS idx_incidents_workspace_status
      ON incidents(workspace_id, status, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_incidents_dedupe
      ON incidents(workspace_id, dedupe_key, opened_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_active_dedupe
      ON incidents(workspace_id, dedupe_key)
      WHERE status != 'resolved';

    CREATE INDEX IF NOT EXISTS idx_incident_events_incident
      ON incident_events(incident_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_incident
      ON notification_deliveries(incident_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_destination
      ON notification_deliveries(destination_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_cron_deliveries_job ON cron_deliveries(job_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_cron_deliveries_session ON cron_deliveries(session_key);
    CREATE INDEX IF NOT EXISTS idx_cron_deliveries_timestamp ON cron_deliveries(timestamp DESC);

    -- Full-text search index on messages for fast keyword search
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, session_key UNINDEXED, role UNINDEXED, timestamp UNINDEXED,
      content='messages', content_rowid='id'
    );

    -- Keep FTS in sync on insert
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, session_key, role, timestamp)
      VALUES (new.id, new.content, new.session_key, new.role, new.timestamp);
    END;

    -- Keep FTS in sync on delete
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, session_key, role, timestamp)
      VALUES ('delete', old.id, old.content, old.session_key, old.role, old.timestamp);
    END;
  `);

  // Backfill FTS index if it's empty but messages exist
  const ftsCount = (database.prepare(`SELECT COUNT(*) as c FROM messages_fts`).get() as { c: number }).c;
  const msgCount = (database.prepare(`SELECT COUNT(*) as c FROM messages WHERE content IS NOT NULL`).get() as { c: number }).c;
  if (ftsCount === 0 && msgCount > 0) {
    database.exec(`INSERT INTO messages_fts(rowid, content, session_key, role, timestamp)
      SELECT id, content, session_key, role, timestamp FROM messages WHERE content IS NOT NULL`);
  }

  db = database;
  stmts = createStatements(database);
  return { db: database, stmts };
}

export function initializeDatabaseFromEnv(): { db: DashboardDatabase; stmts: DashboardStatements } {
  const openclawHome = process.env.OPENCLAW_HOME;
  if (!openclawHome) {
    throw new Error("Missing required environment variable: OPENCLAW_HOME");
  }
  return initializeDatabase(path.join(openclawHome, "dashboard.sqlite"));
}

export function insertIdentityVersion(fileName: string, content: string, label: string | null = null): void {
  stmts.insertIdentityVersion.run({
    file_name: fileName,
    content,
    char_count: content.length,
    label,
  });
}

export function listIdentityVersionCountsByFile(): Map<string, number> {
  const rows = stmts.countIdentityVersionsByFile.all() as Array<{ file_name: string; count: number }>;
  return new Map(rows.map((row) => [row.file_name, row.count]));
}

export function listIdentityVersions(fileName: string, limit: number): IdentityVersionSummary[] {
  return stmts.listIdentityVersionsByFile.all({
    file_name: fileName,
    limit,
  }) as IdentityVersionSummary[];
}

export function getIdentityVersion(fileName: string, id: number): IdentityVersionRecord | undefined {
  return stmts.getIdentityVersionByFileAndId.get({
    file_name: fileName,
    id,
  }) as IdentityVersionRecord | undefined;
}

export function updateIdentityVersionLabel(fileName: string, id: number, label: string | null): boolean {
  const result = stmts.updateIdentityVersionLabel.run({
    file_name: fileName,
    id,
    label,
  });
  return result.changes > 0;
}

export function seedInitialIdentityVersions(workspaceDir: string): number {
  const existing = stmts.countIdentityVersions.get() as { count: number };
  if (existing.count > 0) {
    return 0;
  }

  const seed = db.transaction(() => {
    for (const file of BOOTSTRAP_FILES) {
      const targetPath = path.join(workspaceDir, file.name);
      const content = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
      insertIdentityVersion(file.name, content, "Initial snapshot");
    }
  });

  seed();
  return BOOTSTRAP_FILES.length;
}

// Auto-initialize when OPENCLAW_HOME is set (production/dev).
// Tests call initializeDatabase() directly with a temp path.
if (process.env.OPENCLAW_HOME) {
  initializeDatabaseFromEnv();
}
