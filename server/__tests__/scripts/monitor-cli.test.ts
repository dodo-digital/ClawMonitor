import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import Database from "better-sqlite3";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { createTestPaths, removeTestPaths, type TestPaths } from "../test-helpers.js";

let paths: TestPaths;
let dbPath: string;

function cli(...args: string[]): string {
  const cliPath = path.resolve(import.meta.dirname, "../../scripts/monitor-cli.ts");
  return execFileSync("npx", ["tsx", cliPath, ...args], {
    env: { ...process.env, CLAWMONITOR_DB: dbPath },
    timeout: 15_000,
    encoding: "utf8",
  }).trim();
}

function cliJson(...args: string[]): unknown {
  return JSON.parse(cli(...args, "--json"));
}

beforeAll(() => {
  paths = createTestPaths("monitor-cli-test-");
  dbPath = path.join(paths.openclawHome, "test-monitor.sqlite");

  // Create and seed a test database
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
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
      status TEXT NOT NULL DEFAULT 'running'
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
      timestamp TEXT NOT NULL
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
      actor_user_id TEXT
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  `);

  // Seed test data
  const now = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();

  db.prepare(`INSERT INTO sessions (session_key, agent_id, channel, source, message_count, total_tokens, updated_at)
    VALUES ('sess-abc', 'direct', 'cli', 'local', 10, 500, ?)`).run(now);

  db.prepare(`INSERT INTO agent_runs (run_id, session_key, agent_id, channel, model, started_at, ended_at, duration_ms, status)
    VALUES ('run-001', 'sess-abc', 'direct', 'cli', 'claude-sonnet', ?, ?, 3000, 'completed')`).run(hourAgo, now);

  db.prepare(`INSERT INTO messages (entry_id, run_id, session_key, agent_id, role, content, channel, tokens, timestamp)
    VALUES ('msg-1', 'run-001', 'sess-abc', 'direct', 'user', 'hello world', 'cli', 10, ?)`).run(now);

  db.prepare(`INSERT INTO messages (entry_id, run_id, session_key, agent_id, role, content, channel, tokens, timestamp)
    VALUES ('msg-2', 'run-001', 'sess-abc', 'direct', 'assistant', 'hi there', 'cli', 20, ?)`).run(now);

  db.prepare(`INSERT INTO tool_calls (tool_call_id, run_id, session_key, agent_id, tool_name, input, success, channel, duration_ms, timestamp)
    VALUES ('tc-1', 'run-001', 'sess-abc', 'direct', 'Read', '{"path":"/tmp/test"}', 1, 'cli', 50, ?)`).run(now);

  db.prepare(`INSERT INTO tool_calls (tool_call_id, run_id, session_key, agent_id, tool_name, input, success, channel, duration_ms, timestamp)
    VALUES ('tc-2', 'run-001', 'sess-abc', 'direct', 'Bash', '{"cmd":"ls"}', 0, 'cli', 100, ?)`).run(now);

  db.prepare(`INSERT INTO check_results (workspace_id, check_type, target_key, status, severity, summary, evidence_json, dedupe_key, observed_at)
    VALUES ('default', 'gateway.connection', 'gateway', 'healthy', 'info', 'Gateway connected', '{}', 'gw:healthy', ?)`).run(now);

  db.prepare(`INSERT INTO check_results (workspace_id, check_type, target_key, status, severity, summary, evidence_json, dedupe_key, observed_at)
    VALUES ('default', 'system.disk', '/', 'failing', 'critical', 'Disk at 95%', '{}', 'disk:critical', ?)`).run(now);

  db.prepare(`INSERT INTO incidents (workspace_id, dedupe_key, check_type, target_key, status, severity, title, summary, opened_at, last_seen_at)
    VALUES ('default', 'disk:critical', 'system.disk', '/', 'open', 'critical', 'Disk usage critical', 'Disk at 95%', ?, ?)`).run(hourAgo, now);

  db.prepare(`INSERT INTO incidents (workspace_id, dedupe_key, check_type, target_key, status, severity, title, summary, opened_at, last_seen_at, resolved_at)
    VALUES ('default', 'gw:disconnected', 'gateway.connection', 'gateway', 'resolved', 'critical', 'Gateway disconnected', 'Lost connection', ?, ?, ?)`).run(hourAgo, hourAgo, now);

  db.prepare(`INSERT INTO incident_events (incident_id, event_type, payload_json)
    VALUES (1, 'opened', '{}')`).run();

  db.prepare(`INSERT INTO notification_deliveries (incident_id, event_type, destination_id, destination_name, success, status_code)
    VALUES (1, 'opened', 'telegram', 'Telegram', 1, 200)`).run();

  db.close();
});

afterAll(async () => {
  await removeTestPaths(paths);
});

describe("monitor-cli", () => {
  describe("status", () => {
    it("shows incident and check counts", () => {
      const output = cli("status");
      expect(output).toContain("Incidents:");
      expect(output).toContain("open: 1");
      expect(output).toContain("resolved: 1");
      expect(output).toContain("Health checks");
    });

    it("returns JSON with --json", () => {
      const data = cliJson("status") as Record<string, unknown>;
      expect(data).toHaveProperty("incidents");
      expect(data).toHaveProperty("recentChecks");
      expect(data).toHaveProperty("sessions24h");
    });
  });

  describe("incidents", () => {
    it("lists all incidents", () => {
      const output = cli("incidents");
      expect(output).toContain("Disk usage critical");
      expect(output).toContain("Gateway disconnected");
    });

    it("filters by status", () => {
      const output = cli("incidents", "--status", "open");
      expect(output).toContain("Disk usage critical");
      expect(output).not.toContain("Gateway disconnected");
    });

    it("returns JSON", () => {
      const data = cliJson("incidents") as unknown[];
      expect(data.length).toBe(2);
    });
  });

  describe("incident detail", () => {
    it("shows incident with events and deliveries", () => {
      const output = cli("incident", "1");
      expect(output).toContain("Incident Detail");
      expect(output).toContain("Disk usage critical");
      expect(output).toContain("Events");
      expect(output).toContain("opened");
      expect(output).toContain("Notification Deliveries");
      expect(output).toContain("Telegram");
    });
  });

  describe("checks", () => {
    it("shows latest check results", () => {
      const output = cli("checks");
      expect(output).toContain("gateway.connection");
      expect(output).toContain("system.disk");
      expect(output).toContain("healthy");
      expect(output).toContain("failing");
    });

    it("filters by type", () => {
      const output = cli("checks", "--type", "gateway");
      expect(output).toContain("gateway.connection");
      expect(output).not.toContain("system.disk");
    });
  });

  describe("sessions", () => {
    it("lists sessions", () => {
      const output = cli("sessions");
      expect(output).toContain("direct");
      expect(output).toContain("cli");
    });

    it("filters by agent", () => {
      const output = cli("sessions", "--agent", "direct");
      expect(output).toContain("direct");
    });
  });

  describe("runs", () => {
    it("lists runs", () => {
      const output = cli("runs");
      expect(output).toContain("run-001");
      expect(output).toContain("completed");
    });
  });

  describe("run detail", () => {
    it("shows messages and tool calls", () => {
      const output = cli("run", "run-001");
      expect(output).toContain("Run Detail");
      expect(output).toContain("Messages");
      expect(output).toContain("hello world");
      expect(output).toContain("Tool Calls");
      expect(output).toContain("Read");
      expect(output).toContain("Bash");
    });
  });

  describe("tools", () => {
    it("lists tool calls", () => {
      const output = cli("tools");
      expect(output).toContain("Read");
      expect(output).toContain("Bash");
    });

    it("filters failed only", () => {
      const output = cli("tools", "--failed");
      expect(output).toContain("Bash");
      expect(output).not.toContain("Read");
    });

    it("filters by name", () => {
      const output = cli("tools", "--name", "Read");
      expect(output).toContain("Read");
      expect(output).not.toContain("Bash");
    });
  });

  describe("tables", () => {
    it("shows schema", () => {
      const output = cli("tables");
      expect(output).toContain("incidents");
      expect(output).toContain("check_results");
      expect(output).toContain("sessions");
      expect(output).toContain("tool_calls");
    });
  });

  describe("query", () => {
    it("runs SELECT queries", () => {
      const output = cli("query", "SELECT COUNT(*) as c FROM incidents");
      expect(output).toContain("2");
    });

    it("rejects non-SELECT queries", () => {
      expect(() => cli("query", "DELETE FROM incidents")).toThrow();
    });
  });

  describe("help", () => {
    it("shows usage with --help", () => {
      const output = cli("--help");
      expect(output).toContain("monitor-cli");
      expect(output).toContain("status");
      expect(output).toContain("incidents");
      expect(output).toContain("checks");
    });
  });
});
