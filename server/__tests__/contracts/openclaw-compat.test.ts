/**
 * OpenClaw Compatibility Contract Tests
 *
 * Validates that the dashboard's assumptions about OpenClaw's file formats,
 * config structure, and WS protocol match the currently installed version.
 * Run after every OpenClaw update to catch breaking changes.
 *
 * Requires:
 * - OPENCLAW_HOME pointing to a real OpenClaw installation
 * - OPENCLAW_GATEWAY_TOKEN set for WS protocol tests
 * - A running OpenClaw gateway for WS tests
 *
 * Skip with: SKIP_COMPAT=1 npm test
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? path.join(process.env.HOME!, ".openclaw");
const GATEWAY_WS = process.env.OPENCLAW_GATEWAY_WS ?? "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";

const skipCompat = process.env.SKIP_COMPAT === "1" || !GATEWAY_TOKEN;

// ---------------------------------------------------------------------------
// openclaw.json Contract
// ---------------------------------------------------------------------------

describe.skipIf(skipCompat)("openclaw.json contract", () => {
  const configPath = path.join(OPENCLAW_HOME, "openclaw.json");

  it("file exists and is valid JSON", () => {
    expect(fs.existsSync(configPath)).toBe(true);
    const raw = fs.readFileSync(configPath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("has tools.exec section with expected field types", () => {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const exec = config?.tools?.exec;
    if (!exec) return; // tools.exec may not exist if never configured

    // Validate types of fields we read/write
    if (exec.security !== undefined) expect(typeof exec.security).toBe("string");
    if (exec.ask !== undefined) expect(typeof exec.ask).toBe("string");
    if (exec.strictInlineEval !== undefined) expect(typeof exec.strictInlineEval).toBe("boolean");
  });

  it("has meta.lastTouchedVersion as a string", () => {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (config.meta?.lastTouchedVersion) {
      expect(typeof config.meta.lastTouchedVersion).toBe("string");
    }
  });

  it("agents.list is an array of objects with id", () => {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const list = config.agents?.list;
    if (!list) return;
    expect(Array.isArray(list)).toBe(true);
    for (const agent of list) {
      expect(typeof agent.id).toBe("string");
    }
  });

  it("survives a read-parse-stringify-write round-trip without data loss", () => {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const rewritten = JSON.stringify(parsed, null, 2);
    const reparsed = JSON.parse(rewritten);

    // Key sections preserved
    expect(reparsed.meta).toEqual(parsed.meta);
    expect(reparsed.tools).toEqual(parsed.tools);
    expect(reparsed.agents).toEqual(parsed.agents);
  });
});

// ---------------------------------------------------------------------------
// exec-approvals.json Contract
// ---------------------------------------------------------------------------

describe.skipIf(skipCompat)("exec-approvals.json contract", () => {
  const approvalsPath = path.join(OPENCLAW_HOME, "exec-approvals.json");

  it("file exists and has expected top-level structure", () => {
    expect(fs.existsSync(approvalsPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(approvalsPath, "utf8"));

    expect(raw).toHaveProperty("version");
    expect(raw).toHaveProperty("defaults");
    expect(raw).toHaveProperty("agents");
    expect(typeof raw.defaults).toBe("object");
    expect(typeof raw.agents).toBe("object");
  });

  it("defaults fields are strings when present", () => {
    const raw = JSON.parse(fs.readFileSync(approvalsPath, "utf8"));
    const defaults = raw.defaults;

    if (defaults.security !== undefined) expect(typeof defaults.security).toBe("string");
    if (defaults.ask !== undefined) expect(typeof defaults.ask).toBe("string");
    if (defaults.askFallback !== undefined) expect(typeof defaults.askFallback).toBe("string");
  });

  it("allowlist entries have a pattern string", () => {
    const raw = JSON.parse(fs.readFileSync(approvalsPath, "utf8"));

    for (const [, agentValue] of Object.entries(raw.agents)) {
      const agent = agentValue as { allowlist?: unknown[] };
      if (agent.allowlist) {
        for (const entry of agent.allowlist) {
          expect(typeof (entry as Record<string, unknown>).pattern).toBe("string");
        }
      }
    }
  });

  it("has a socket.path field", () => {
    const raw = JSON.parse(fs.readFileSync(approvalsPath, "utf8"));
    if (raw.socket) {
      expect(typeof raw.socket.path).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Cron files Contract
// ---------------------------------------------------------------------------

describe.skipIf(skipCompat)("cron files contract", () => {
  it("jobs.json exists with expected structure", () => {
    const jobsPath = path.join(OPENCLAW_HOME, "cron", "jobs.json");
    if (!fs.existsSync(jobsPath)) return;

    const raw = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
    expect(raw).toHaveProperty("jobs");
    expect(Array.isArray(raw.jobs)).toBe(true);

    if (raw.jobs.length > 0) {
      const job = raw.jobs[0];
      expect(job).toHaveProperty("id");
      expect(job).toHaveProperty("enabled");
      expect(typeof job.id).toBe("string");
      expect(typeof job.enabled).toBe("boolean");
    }
  });

  it("cron runs directory exists", () => {
    const runsDir = path.join(OPENCLAW_HOME, "cron", "runs");
    // Runs dir may not exist if no cron jobs have run yet
    if (fs.existsSync(runsDir)) {
      const stat = fs.statSync(runsDir);
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it("run JSONL files have expected entry shape", () => {
    const runsDir = path.join(OPENCLAW_HOME, "cron", "runs");
    if (!fs.existsSync(runsDir)) return;

    const files = fs.readdirSync(runsDir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return;

    const content = fs.readFileSync(path.join(runsDir, files[0]), "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return;

    const entry = JSON.parse(lines[lines.length - 1]);
    // Fields our dashboard reads
    expect(entry).toHaveProperty("ts");
    expect(entry).toHaveProperty("status");
    expect(typeof entry.ts).toBe("number");
    expect(typeof entry.status).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Gateway WebSocket Protocol Contract
// ---------------------------------------------------------------------------

describe.skipIf(skipCompat)("gateway WebSocket protocol contract", () => {
  it("handshake succeeds and advertises the methods and events we depend on", async () => {
    const ws = new WebSocket(GATEWAY_WS);

    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Handshake timeout"));
      }, 10_000);

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;

        if (msg.type === "event" && msg.event === "connect.challenge") {
          ws.send(JSON.stringify({
            type: "req",
            id: crypto.randomUUID(),
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              auth: { token: GATEWAY_TOKEN },
              client: {
                id: "openclaw-probe",
                version: "0.1.0",
                mode: "backend",
                platform: "linux",
                displayName: "Compat Test",
                instanceId: crypto.randomUUID(),
              },
            },
          }));
        }

        if (msg.type === "res" && msg.ok) {
          const payload = msg.payload as Record<string, unknown> | undefined;
          if (payload?.type === "hello-ok") {
            clearTimeout(timeout);
            ws.close();
            resolve(msg);
          }
        }

        if (msg.type === "res" && !msg.ok) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`Handshake rejected: ${JSON.stringify(msg)}`));
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const payload = result.payload as Record<string, unknown>;
    expect(payload.type).toBe("hello-ok");
    expect(payload.protocol).toBe(3);

    const features = payload.features as { methods: string[]; events: string[] };

    // Methods the dashboard calls
    const requiredMethods = [
      "exec.approval.resolve",
      "exec.approvals.get",
      "config.get",
      "config.schema.lookup",
      "cron.list",
      "cron.status",
      "health",
    ];
    for (const method of requiredMethods) {
      expect(features.methods, `missing method: ${method}`).toContain(method);
    }

    // Events the dashboard listens for
    const requiredEvents = [
      "exec.approval.requested",
      "exec.approval.resolved",
      "session.message",
      "session.tool",
    ];
    for (const event of requiredEvents) {
      expect(features.events, `missing event: ${event}`).toContain(event);
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// OpenClaw CLI + Version
// ---------------------------------------------------------------------------

describe.skipIf(skipCompat)("OpenClaw CLI contract", () => {
  it("openclaw --version returns a version string", () => {
    const proc = spawnSync("openclaw", ["--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
    });
    const version = (proc.stdout || proc.stderr).trim();
    expect(version).toBeTruthy();
    expect(version).toMatch(/\d{4}\.\d+/); // e.g., 2026.4.1
    console.log(`[compat] OpenClaw version: ${version}`);
  });

  it("openclaw binary exists and is executable", () => {
    const bin = `${process.env.HOME}/.local/bin/openclaw`;
    expect(fs.existsSync(bin)).toBe(true);
    const stat = fs.statSync(bin);
    // Check execute permission (owner)
    expect(stat.mode & 0o100).toBeGreaterThan(0);
  });
});
