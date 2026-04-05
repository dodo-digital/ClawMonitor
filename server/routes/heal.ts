import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { Router } from "express";

import { db } from "../lib/db.js";
import { asyncHandler, ok } from "../lib/http.js";
import { HttpError } from "../lib/errors.js";
import { PROJECT_ROOT } from "../lib/constants.js";
import { DEFAULT_WORKSPACE_ID } from "../monitor/workspace.js";

const execFileAsync = promisify(execFile);

export const healRouter = Router();

const VALID_TARGETS = ["all", "gateway", "auth", "exec", "cron", "sessions"] as const;
type HealTarget = (typeof VALID_TARGETS)[number];

function isValidTarget(target: string): target is HealTarget {
  return (VALID_TARGETS as readonly string[]).includes(target);
}

// POST /api/system/heal — run heal.sh
healRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const target = String(req.body?.target ?? "all");
    const dryRun = Boolean(req.body?.dryRun ?? false);

    if (!isValidTarget(target)) {
      throw new HttpError(`Invalid target: ${target}. Valid targets: ${VALID_TARGETS.join(", ")}`, 400);
    }

    const scriptPath = path.join(PROJECT_ROOT, "server", "scripts", "heal.sh");
    const args = ["--json", "--target", target];
    if (dryRun) args.push("--dry-run");

    try {
      const { stdout } = await execFileAsync("bash", [scriptPath, ...args], {
        timeout: 60_000,
        env: { ...process.env },
      });

      const result = JSON.parse(stdout.trim());

      // Store the run in the DB
      db.prepare(
        `INSERT INTO heal_runs (workspace_id, target, dry_run, result_json, success, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      ).run(
        DEFAULT_WORKSPACE_ID,
        target,
        dryRun ? 1 : 0,
        JSON.stringify(result),
        result.success ? 1 : 0,
      );

      ok(res, result);
    } catch (error) {
      // Even if the script exits non-zero, try to parse JSON output
      const err = error as { stdout?: string; stderr?: string; message?: string };
      if (err.stdout) {
        try {
          const result = JSON.parse(err.stdout.trim());
          db.prepare(
            `INSERT INTO heal_runs (workspace_id, target, dry_run, result_json, success, created_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`,
          ).run(DEFAULT_WORKSPACE_ID, target, dryRun ? 1 : 0, JSON.stringify(result), 0);
          ok(res, result);
          return;
        } catch {
          // fall through
        }
      }
      throw new HttpError(`Heal script failed: ${err.message ?? "unknown error"}`, 500);
    }
  }),
);

// POST /api/system/triage — run check-update.sh
healRouter.post(
  "/triage",
  asyncHandler(async (req, res) => {
    const autoFix = Boolean(req.body?.autoFix ?? false);
    const scriptPath = path.join(PROJECT_ROOT, "server", "scripts", "check-update.sh");
    const args = ["--json"];
    if (autoFix) args.push("--auto-fix");

    try {
      const { stdout } = await execFileAsync("bash", [scriptPath, ...args], {
        timeout: 60_000,
        env: { ...process.env },
      });

      ok(res, JSON.parse(stdout.trim()));
    } catch (error) {
      const err = error as { stdout?: string; message?: string };
      if (err.stdout) {
        try {
          ok(res, JSON.parse(err.stdout.trim()));
          return;
        } catch {
          // fall through
        }
      }
      throw new HttpError(`Triage script failed: ${err.message ?? "unknown error"}`, 500);
    }
  }),
);

// GET /api/system/heal/history — recent heal runs
healRouter.get(
  "/history",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
    const rows = db
      .prepare(
        `SELECT id, target, dry_run, result_json, success, created_at
         FROM heal_runs
         WHERE workspace_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(DEFAULT_WORKSPACE_ID, limit) as Array<{
      id: number;
      target: string;
      dry_run: number;
      result_json: string;
      success: number;
      created_at: string;
    }>;

    const items = rows.map((row) => ({
      id: row.id,
      target: row.target,
      dryRun: row.dry_run === 1,
      result: JSON.parse(row.result_json),
      success: row.success === 1,
      createdAt: row.created_at,
    }));

    ok(res, { items });
  }),
);
