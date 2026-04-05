import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase, db } from "../../lib/db.js";

// These tests must reset modules to override env before importing security
// functions, because env.ts loads eagerly. We use dynamic imports instead.

describe("security compliance scoring", () => {
  let rootDir: string;
  let openclawHome: string;
  let workspaceDir: string;

  beforeEach(() => {
    vi.resetModules();

    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-security-scan-"));
    const dbPath = path.join(rootDir, "dashboard.sqlite");
    openclawHome = path.join(rootDir, ".openclaw");
    workspaceDir = path.join(openclawHome, "workspace");

    fs.mkdirSync(openclawHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(path.join(openclawHome, "agents", "direct", "agent"), { recursive: true });
    fs.mkdirSync(path.join(openclawHome, "skills"), { recursive: true });

    // Write a valid openclaw.json with exec settings
    fs.writeFileSync(
      path.join(openclawHome, "openclaw.json"),
      JSON.stringify({
        tools: { exec: { security: "full", strictInlineEval: false } },
      }),
    );

    // Write valid exec-approvals.json
    fs.writeFileSync(
      path.join(openclawHome, "exec-approvals.json"),
      JSON.stringify({
        defaults: { security: "full", ask: "off", askFallback: "full" },
      }),
    );

    // Write valid auth profiles
    fs.writeFileSync(
      path.join(openclawHome, "agents", "direct", "agent", "auth-profiles.json"),
      JSON.stringify({
        profiles: {
          anthropic: { provider: "anthropic", type: "api", key: "test-key" },
        },
      }),
    );

    process.env.OPENCLAW_HOME = openclawHome;
    process.env.OPENCLAW_WORKSPACE = workspaceDir;
    process.env.OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789";
    process.env.OPENCLAW_GATEWAY_WS = "ws://127.0.0.1:18789";
    process.env.OPENCLAW_GATEWAY_TOKEN = "test-token";

    initializeDatabase(dbPath);
  });

  afterEach(async () => {
    db.close();
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  it("computes a compliance score with valid structure", async () => {
    const { computeComplianceScore } = await import("../../monitor/checks/security.js");
    const report = await computeComplianceScore();
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(report.grade).toMatch(/^[A-F]$/);
    expect(report.breakdown).toBeDefined();
    expect(report.breakdown.execPosture).toBeDefined();
    expect(report.breakdown.credentialExposure).toBeDefined();
    expect(report.breakdown.skillIntegrity).toBeDefined();
    expect(report.breakdown.authHealth).toBeDefined();
    expect(report.scannedAt).toBeDefined();
  });

  it("finds no secrets in clean tool outputs", async () => {
    const { computeComplianceScore } = await import("../../monitor/checks/security.js");

    // Insert a session first (foreign key), then tool call
    db.prepare(
      "INSERT INTO sessions (session_key, agent_id, channel) VALUES (?, ?, ?)",
    ).run("session-1", "direct", "test");
    db.prepare(
      "INSERT INTO tool_calls (tool_call_id, session_key, agent_id, tool_name, output, channel, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
    ).run("tc-1", "session-1", "direct", "test-tool", "Hello world, no secrets here", "test", "test");

    const report = await computeComplianceScore();
    expect(report.breakdown.credentialExposure.findings).toHaveLength(0);
    expect(report.breakdown.credentialExposure.score).toBe(report.breakdown.credentialExposure.max);
  });

  it("detects secrets via scanForSecrets directly", async () => {
    // Test the underlying scan function rather than the full pipeline
    // (full pipeline depends on env module loading order)
    const { scanForSecrets } = await import("../../lib/redact.js");
    const findings = scanForSecrets("aws key: AKIAIOSFODNN7EXAMPLE and token: ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(findings.length).toBe(2);
    expect(findings.map((f) => f.label).sort()).toEqual(["aws-key", "github-token"]);
  });

  it("saves and retrieves scan history", async () => {
    const { saveSecurityScan, getSecurityHistory } = await import("../../monitor/checks/security.js");

    saveSecurityScan({ score: 90, grade: "A", breakdown: {} as any, scannedAt: "2026-04-01T00:00:00Z" });
    saveSecurityScan({ score: 75, grade: "C", breakdown: {} as any, scannedAt: "2026-04-02T00:00:00Z" });

    const history = getSecurityHistory();
    expect(history.length).toBe(2);
    // Ordered by scanned_at DESC — second insert should be first
    expect(history[0].score).toBe(75);
    expect(history[1].score).toBe(90);
  });

  it("retrieves latest scan", async () => {
    const { computeComplianceScore, saveSecurityScan, getLatestSecurityScan } = await import("../../monitor/checks/security.js");

    const report = await computeComplianceScore();
    saveSecurityScan(report);

    const latest = getLatestSecurityScan();
    expect(latest).not.toBeNull();
    expect(latest!.score).toBe(report.score);
  });

  it("saves and compares skill baseline", async () => {
    const { saveSecurityBaseline, computeComplianceScore } = await import("../../monitor/checks/security.js");

    // Create a skill file
    const skillDir = path.join(openclawHome, "skills", "test-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Test Skill\nHello");

    const result = await saveSecurityBaseline();
    expect(result.fileCount).toBeGreaterThan(0);

    // Now compute score — should show no drift
    const report = await computeComplianceScore();
    expect(report.breakdown.skillIntegrity.added).toHaveLength(0);
    expect(report.breakdown.skillIntegrity.modified).toHaveLength(0);
    expect(report.breakdown.skillIntegrity.removed).toHaveLength(0);
  });

  it("detects skill drift after baseline change", async () => {
    const { saveSecurityBaseline, computeComplianceScore } = await import("../../monitor/checks/security.js");

    const skillDir = path.join(openclawHome, "skills", "test-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Test Skill\nOriginal");
    await saveSecurityBaseline();

    // Modify the skill
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Test Skill\nModified content");

    const report = await computeComplianceScore();
    expect(report.breakdown.skillIntegrity.modified.length).toBeGreaterThan(0);
  });
});
