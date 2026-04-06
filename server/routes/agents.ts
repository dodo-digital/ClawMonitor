import fs from "node:fs";
import path from "node:path";

import { Router } from "express";

import { BOOTSTRAP_FILES } from "../lib/constants.js";
import { env } from "../lib/env.js";
import { readOpenClawConfig } from "../lib/openclaw.js";
import { readJsonFile } from "../lib/filesystem.js";
import { asyncHandler, ok } from "../lib/http.js";

/** Derive a human-friendly display name from agent config or ID */
function toDisplayName(agent: Record<string, unknown>): string {
  // Use explicit name from config if set
  if (agent.name && typeof agent.name === "string") return agent.name;
  // For ACP agents, try to derive from workspace dir name
  const workspace = agent.workspace as string | undefined;
  if (workspace) {
    const dirName = workspace.replace(/\/+$/, "").split("/").pop() ?? "";
    if (dirName && dirName !== "workspace") {
      return dirName.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  // Fall back to title-cased ID
  const id = String(agent.id ?? "");
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const agentsRouter = Router();

agentsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const config = await readOpenClawConfig();
    const agents = config.agents?.list ?? [];
    const bindings = config.bindings ?? [];

    // Read cron jobs once to count per agent
    const cronJobsPath = path.join(env.openclawHome, "cron", "jobs.json");
    type CronJobEntry = { agentId?: string };
    let cronJobs: CronJobEntry[] = [];
    try {
      const raw = await readJsonFile<Record<string, CronJobEntry> | CronJobEntry[]>(cronJobsPath);
      cronJobs = Array.isArray(raw) ? raw : Object.values(raw);
    } catch { /* no cron jobs */ }

    const items = await Promise.all(
      agents.map(async (agent) => {
        const agentId = String(agent.id ?? "");
        const runtimeType = (agent.runtime as { type?: string } | undefined)?.type ?? "native";
        const workspace = (agent.workspace as string) ??
          ((config.agents?.defaults as Record<string, unknown> | undefined)?.workspace as string) ?? null;

        const sessionsPath = path.join(env.openclawHome, "agents", agentId, "sessions", "sessions.json");
        const sessionCount = fs.existsSync(sessionsPath)
          ? Object.keys(await readJsonFile<Record<string, unknown>>(sessionsPath)).length
          : 0;

        const binding = bindings.find((entry) => entry.agentId === agentId && entry.match);

        // Identity files check
        const identityFiles = workspace
          ? BOOTSTRAP_FILES.filter((f) => f.name !== "BOOTSTRAP.md" && f.name !== "MEMORY.md").map((f) => ({
              name: f.name,
              exists: fs.existsSync(path.join(workspace, f.name)),
            }))
          : [];

        // Cron job count for this agent
        const cronJobCount = cronJobs.filter((j) => j.agentId === agentId).length;

        return {
          id: agentId,
          displayName: toDisplayName(agent),
          workspace,
          model: agent.model ?? config.agents?.defaults?.model ?? null,
          runtimeType,
          telegramBinding: binding ?? null,
          sessionCount,
          identityFiles,
          cronJobCount,
        };
      }),
    );
    ok(res, items);
  }),
);

agentsRouter.get(
  "/auth-profiles",
  asyncHandler(async (req, res) => {
    const agentId = req.query.agent ? String(req.query.agent) : "direct";
    const profilesPath = path.join(env.openclawHome, "agents", agentId, "agent", "auth-profiles.json");
    const authProfiles = await readJsonFile<{
      profiles?: Record<string, { key?: string; access?: string; provider?: string; type?: string }>;
    }>(profilesPath);
    const items = Object.entries(authProfiles.profiles ?? {}).map(([name, profile]) => ({
      name,
      status: {
        hasApiKey: Boolean(profile.key),
        hasAccessToken: Boolean(profile.access),
        provider: profile.provider ?? null,
        type: profile.type ?? null,
      },
    }));
    ok(res, items);
  }),
);

agentsRouter.get(
  "/acp",
  asyncHandler(async (_req, res) => {
    const config = await readOpenClawConfig();
    ok(res, config.acp ?? {});
  }),
);
