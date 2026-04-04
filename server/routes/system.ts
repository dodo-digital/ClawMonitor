import fs from "node:fs";
import path from "node:path";

import { Router } from "express";

import { TTLCache } from "../lib/cache.js";
import { env } from "../lib/env.js";
import { HttpError } from "../lib/errors.js";
import { readOpenClawConfig, summarizeConfig } from "../lib/openclaw.js";
import { readJsonFile } from "../lib/filesystem.js";
import { asyncHandler, ok } from "../lib/http.js";
import { readExecSecurityStatus, writeExecSecuritySettings, type ExecSecurityUpdate } from "../monitor/checks/core.js";
import type { LiveFeedBridge } from "../ws/live-feed.js";
import {
  getGatewayModels,
  getOpenClawVersionAndPid,
  getQmdStatusOutput,
  getSystemHealth,
  getTailscaleStatus,
  getUserServices,
} from "../lib/system-info.js";

const cache = new TTLCache<string, unknown>();

function countLast24HourSessions(commandLogPath: string): Record<string, unknown> {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const counts = new Map<string, number>();
  let total = 0;

  if (!fs.existsSync(commandLogPath)) {
    return { totalSessions: 0, bySource: {} };
  }

  const lines = fs.readFileSync(commandLogPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let entry: { timestamp?: string; action?: string; source?: string };
    try {
      entry = JSON.parse(line) as { timestamp?: string; action?: string; source?: string };
    } catch {
      continue;
    }
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    if (entry.action !== "new" || Number.isNaN(ts) || ts < since) {
      continue;
    }

    total += 1;
    const source = entry.source ?? "unknown";
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  return {
    totalSessions: total,
    bySource: Object.fromEntries(counts.entries()),
  };
}

export const systemRouter = Router();

systemRouter.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const data = await cache.getOrSet("system:health", () => getSystemHealth(), 30_000);
    ok(res, data);
  }),
);

systemRouter.get(
  "/services",
  asyncHandler(async (_req, res) => {
    ok(res, { raw: await getUserServices() });
  }),
);

systemRouter.get(
  "/tailscale",
  asyncHandler(async (_req, res) => {
    ok(res, { raw: await getTailscaleStatus() });
  }),
);

systemRouter.get(
  "/openclaw",
  asyncHandler(async (_req, res) => {
    const [config, runtime, execSecurity] = await Promise.all([
      readOpenClawConfig(),
      getOpenClawVersionAndPid(),
      readExecSecurityStatus(),
    ]);
    ok(res, {
      version: runtime.version ?? config.meta?.lastTouchedVersion ?? null,
      gatewayPid: runtime.pid,
      configSummary: summarizeConfig(config),
      execSecurity,
    });
  }),
);

systemRouter.get(
  "/exec-security",
  asyncHandler(async (_req, res) => {
    ok(res, await readExecSecurityStatus());
  }),
);

systemRouter.put(
  "/exec-security",
  asyncHandler(async (req, res) => {
    const body = req.body as ExecSecurityUpdate;
    await writeExecSecuritySettings(body);
    ok(res, await readExecSecurityStatus());
  }),
);

// --- Exec Approval Queue ---

systemRouter.get(
  "/exec-approvals/pending",
  asyncHandler(async (req, res) => {
    const liveFeed = req.app.locals.liveFeed as LiveFeedBridge | null;
    if (!liveFeed) {
      ok(res, { approvals: [] });
      return;
    }
    ok(res, { approvals: liveFeed.getPendingApprovals() });
  }),
);

systemRouter.post(
  "/exec-approvals/:id/resolve",
  asyncHandler(async (req, res) => {
    const liveFeed = req.app.locals.liveFeed as LiveFeedBridge | null;
    if (!liveFeed) {
      throw new HttpError("Live feed not available", 503);
    }
    const id = String(req.params.id);
    const { decision } = req.body as { decision: "allow-once" | "allow-always" | "deny" };
    if (!decision || !["allow-once", "allow-always", "deny"].includes(decision)) {
      throw new HttpError("Invalid decision — must be allow-once, allow-always, or deny", 400);
    }
    await liveFeed.resolveApproval(id, decision);
    ok(res, { resolved: true });
  }),
);

systemRouter.get(
  "/models",
  asyncHandler(async (_req, res) => {
    ok(res, await getGatewayModels());
  }),
);

systemRouter.get(
  "/summary",
  asyncHandler(async (_req, res) => {
    const commandLogPath = path.join(env.openclawHome, "logs", "commands.log");
    ok(res, countLast24HourSessions(commandLogPath));
  }),
);
