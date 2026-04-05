/**
 * Security compliance scoring.
 *
 * Scoring model adapted from openclaw-ops (MIT License, Cathryn Lavery).
 * @see https://github.com/cathrynlavery/openclaw-ops
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { db } from "../../lib/db.js";
import { env } from "../../lib/env.js";
import { readJsonFile } from "../../lib/filesystem.js";
import { scanForSecrets, type SecretMatch } from "../../lib/redact.js";
import { DEFAULT_WORKSPACE_ID } from "../workspace.js";
import { readExecSecurityStatus, type ExecSecurityStatus } from "./core.js";
import type { MonitorCheckResultInput } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CategoryScore = {
  score: number;
  max: number;
  details: string[];
};

export type CredentialCategory = CategoryScore & {
  findings: SecretMatch[];
};

export type SkillDriftCategory = CategoryScore & {
  added: string[];
  removed: string[];
  modified: string[];
  baselineCount: number;
  currentCount: number;
};

export type SecurityComplianceReport = {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  breakdown: {
    execPosture: CategoryScore;
    credentialExposure: CredentialCategory;
    skillIntegrity: SkillDriftCategory;
    authHealth: CategoryScore;
  };
  scannedAt: string;
};

// ---------------------------------------------------------------------------
// Exec posture scoring (0-30)
// ---------------------------------------------------------------------------

function scoreExecPosture(status: ExecSecurityStatus): CategoryScore {
  const max = 30;
  let score = max;
  const details: string[] = [];

  const sec = status.settings.gatewayExecSecurity;
  if (sec === "full") {
    details.push("Gateway exec security: full (good)");
  } else if (sec === "allowlist") {
    score -= 10;
    details.push("Gateway exec security: allowlist (-10)");
  } else if (sec === "deny") {
    // Deny is very secure but breaks cron
    score -= 5;
    details.push("Gateway exec security: deny (secure but may block cron, -5)");
  } else {
    score -= 15;
    details.push(`Gateway exec security: ${sec ?? "not set"} (-15)`);
  }

  if (status.settings.approvalsDefaultAsk === "always" || status.settings.approvalsDefaultAsk === "on-miss") {
    const fallback = status.settings.approvalsDefaultAskFallback;
    if (fallback === "deny") {
      score -= 10;
      details.push("Approval fallback is deny — cron will fail silently (-10)");
    } else if (fallback !== "full") {
      score -= 5;
      details.push(`Approval fallback: ${fallback ?? "not set"} (-5)`);
    } else {
      details.push("Approval fallback: full (OK for cron)");
    }
  }

  if (status.settings.approvalsHasWildcard) {
    score -= 5;
    details.push("Wildcard allowlist present — all commands approved (-5)");
  }

  return { score: Math.max(0, score), max, details };
}

// ---------------------------------------------------------------------------
// Credential exposure scoring (0-30)
// ---------------------------------------------------------------------------

function scoreCredentialExposure(): CredentialCategory {
  const max = 30;
  const details: string[] = [];

  // Scan recent tool call outputs for secrets
  const recentOutputs = db
    .prepare(
      `SELECT output FROM tool_calls
       WHERE output IS NOT NULL AND timestamp > datetime('now', '-24 hours')
       ORDER BY timestamp DESC LIMIT 500`,
    )
    .all() as Array<{ output: string }>;

  const allFindings: SecretMatch[] = [];
  for (const row of recentOutputs) {
    const matches = scanForSecrets(row.output);
    allFindings.push(...matches);
  }

  if (allFindings.length === 0) {
    details.push("No secrets found in recent tool outputs");
    return { score: max, max, details, findings: [] };
  }

  // Deduct based on count — more findings = worse
  const deduction = Math.min(max, allFindings.length * 5);
  details.push(`Found ${allFindings.length} secret(s) in recent tool outputs (-${deduction})`);

  return { score: Math.max(0, max - deduction), max, details, findings: allFindings };
}

// ---------------------------------------------------------------------------
// Skill integrity scoring (0-20)
// ---------------------------------------------------------------------------

async function computeSkillHashes(): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const skillsDir = path.join(env.openclawHome, "skills");

  if (!fs.existsSync(skillsDir)) return hashes;

  async function walk(dir: string, base: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        const content = await fs.promises.readFile(full);
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        hashes.set(rel, hash);
      }
    }
  }

  await walk(skillsDir, "");
  return hashes;
}

function scoreSkillIntegrity(): SkillDriftCategory {
  const max = 20;
  const details: string[] = [];

  // Check if we have a baseline
  const baselineRows = db
    .prepare("SELECT file_path, sha256 FROM security_baseline WHERE workspace_id = ?")
    .all(DEFAULT_WORKSPACE_ID) as Array<{ file_path: string; sha256: string }>;

  if (baselineRows.length === 0) {
    details.push("No skill baseline set — run a baseline scan to enable drift detection");
    return { score: max, max, details, added: [], removed: [], modified: [], baselineCount: 0, currentCount: 0 };
  }

  // We can't do async in a synchronous scoring context, so we read the
  // last cached scan result from the security_scans table instead.
  // The actual drift comparison happens in the async computeComplianceScore().
  // This placeholder returns the max score; the async caller overrides it.
  return { score: max, max, details, added: [], removed: [], modified: [], baselineCount: baselineRows.length, currentCount: 0 };
}

async function scoreSkillIntegrityAsync(): Promise<SkillDriftCategory> {
  const max = 20;
  const details: string[] = [];

  const baselineRows = db
    .prepare("SELECT file_path, sha256 FROM security_baseline WHERE workspace_id = ?")
    .all(DEFAULT_WORKSPACE_ID) as Array<{ file_path: string; sha256: string }>;

  if (baselineRows.length === 0) {
    details.push("No skill baseline set — run a baseline scan to enable drift detection");
    return { score: max, max, details, added: [], removed: [], modified: [], baselineCount: 0, currentCount: 0 };
  }

  const baseline = new Map(baselineRows.map((r) => [r.file_path, r.sha256]));
  const current = await computeSkillHashes();

  const baselineKeys = new Set(baseline.keys());
  const currentKeys = new Set(current.keys());

  const added = [...currentKeys].filter((k) => !baselineKeys.has(k)).sort();
  const removed = [...baselineKeys].filter((k) => !currentKeys.has(k)).sort();
  const modified = [...currentKeys]
    .filter((k) => baselineKeys.has(k) && current.get(k) !== baseline.get(k))
    .sort();

  const changes = added.length + removed.length + modified.length;
  if (changes === 0) {
    details.push("All skill files match baseline");
    return { score: max, max, details, added, removed, modified, baselineCount: baseline.size, currentCount: current.size };
  }

  const deduction = Math.min(max, changes * 4);
  if (added.length > 0) details.push(`${added.length} new skill file(s)`);
  if (modified.length > 0) details.push(`${modified.length} modified skill file(s)`);
  if (removed.length > 0) details.push(`${removed.length} removed skill file(s)`);
  details.push(`(-${deduction})`);

  return {
    score: Math.max(0, max - deduction),
    max,
    details,
    added,
    removed,
    modified,
    baselineCount: baseline.size,
    currentCount: current.size,
  };
}

// ---------------------------------------------------------------------------
// Auth health scoring (0-20)
// ---------------------------------------------------------------------------

async function scoreAuthHealth(): Promise<CategoryScore> {
  const max = 20;
  const details: string[] = [];

  const profilesPath = path.join(env.openclawHome, "agents", "direct", "agent", "auth-profiles.json");

  if (!fs.existsSync(profilesPath)) {
    details.push("Auth profiles file is missing (-20)");
    return { score: 0, max, details };
  }

  try {
    const authProfiles = await readJsonFile<{
      profiles?: Record<string, { key?: string; access?: string; provider?: string; type?: string }>;
    }>(profilesPath);

    const profiles = Object.entries(authProfiles.profiles ?? {});
    if (profiles.length === 0) {
      details.push("No auth profiles configured (-20)");
      return { score: 0, max, details };
    }

    const invalid = profiles.filter(
      ([, p]) => !(p.provider && p.type && (p.key || p.access)),
    );

    if (invalid.length > 0) {
      const deduction = Math.min(max, invalid.length * 10);
      details.push(`${invalid.length} malformed auth profile(s) (-${deduction})`);
      return { score: Math.max(0, max - deduction), max, details };
    }

    details.push(`${profiles.length} valid auth profile(s)`);
    return { score: max, max, details };
  } catch {
    details.push("Failed to read auth profiles (-10)");
    return { score: max - 10, max, details };
  }
}

// ---------------------------------------------------------------------------
// Grade from score
// ---------------------------------------------------------------------------

function gradeFromScore(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function computeComplianceScore(): Promise<SecurityComplianceReport> {
  const execStatus = await readExecSecurityStatus();
  const execPosture = scoreExecPosture(execStatus);
  const credentialExposure = scoreCredentialExposure();
  const skillIntegrity = await scoreSkillIntegrityAsync();
  const authHealth = await scoreAuthHealth();

  const score = execPosture.score + credentialExposure.score + skillIntegrity.score + authHealth.score;

  return {
    score,
    grade: gradeFromScore(score),
    breakdown: { execPosture, credentialExposure, skillIntegrity, authHealth },
    scannedAt: new Date().toISOString(),
  };
}

export async function saveSecurityBaseline(): Promise<{ fileCount: number }> {
  const hashes = await computeSkillHashes();

  const insert = db.prepare(
    "INSERT INTO security_baseline (workspace_id, file_path, sha256, recorded_at) VALUES (?, ?, ?, datetime('now'))",
  );

  const run = db.transaction(() => {
    // Clear old baseline
    db.prepare("DELETE FROM security_baseline WHERE workspace_id = ?").run(DEFAULT_WORKSPACE_ID);
    for (const [filePath, sha256] of hashes) {
      insert.run(DEFAULT_WORKSPACE_ID, filePath, sha256);
    }
  });

  run();
  return { fileCount: hashes.size };
}

export function saveSecurityScan(report: SecurityComplianceReport): void {
  db.prepare(
    "INSERT INTO security_scans (workspace_id, score, breakdown_json, scanned_at) VALUES (?, ?, ?, ?)",
  ).run(DEFAULT_WORKSPACE_ID, report.score, JSON.stringify(report.breakdown), report.scannedAt);
}

export function getSecurityHistory(limit = 50): Array<{ id: number; score: number; scanned_at: string }> {
  return db
    .prepare(
      "SELECT id, score, scanned_at FROM security_scans WHERE workspace_id = ? ORDER BY scanned_at DESC LIMIT ?",
    )
    .all(DEFAULT_WORKSPACE_ID, limit) as Array<{ id: number; score: number; scanned_at: string }>;
}

export function getLatestSecurityScan(): SecurityComplianceReport | null {
  const row = db
    .prepare(
      "SELECT score, breakdown_json, scanned_at FROM security_scans WHERE workspace_id = ? ORDER BY scanned_at DESC LIMIT 1",
    )
    .get(DEFAULT_WORKSPACE_ID) as { score: number; breakdown_json: string; scanned_at: string } | undefined;

  if (!row) return null;

  return {
    score: row.score,
    grade: gradeFromScore(row.score),
    breakdown: JSON.parse(row.breakdown_json),
    scannedAt: row.scanned_at,
  };
}

export async function runSecurityScanCheck(): Promise<MonitorCheckResultInput> {
  const report = await computeComplianceScore();
  saveSecurityScan(report);

  const now = new Date().toISOString();

  if (report.score < 50) {
    return {
      workspaceId: DEFAULT_WORKSPACE_ID,
      observedAt: now,
      checkType: "security.compliance",
      targetKey: "security",
      status: "failing",
      severity: "critical",
      summary: `Security compliance score: ${report.score}/100 (grade ${report.grade})`,
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:security.compliance:security:failing`,
      title: "Security compliance failing",
      evidence: report as unknown as Record<string, unknown>,
    };
  }

  if (report.score < 80) {
    return {
      workspaceId: DEFAULT_WORKSPACE_ID,
      observedAt: now,
      checkType: "security.compliance",
      targetKey: "security",
      status: "degraded",
      severity: "warning",
      summary: `Security compliance score: ${report.score}/100 (grade ${report.grade})`,
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:security.compliance:security:degraded`,
      title: "Security compliance degraded",
      evidence: report as unknown as Record<string, unknown>,
    };
  }

  return {
    workspaceId: DEFAULT_WORKSPACE_ID,
    observedAt: now,
    checkType: "security.compliance",
    targetKey: "security",
    status: "healthy",
    severity: "info",
    summary: `Security compliance score: ${report.score}/100 (grade ${report.grade})`,
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:security.compliance:security:healthy`,
    title: "Security compliance healthy",
    evidence: report as unknown as Record<string, unknown>,
  };
}
