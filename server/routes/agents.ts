import fs from "node:fs";
import path from "node:path";

import { Router } from "express";

import { env } from "../lib/env.js";
import { readOpenClawConfig } from "../lib/openclaw.js";
import { readJsonFile } from "../lib/filesystem.js";
import { asyncHandler, ok } from "../lib/http.js";

export const agentsRouter = Router();

agentsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const config = await readOpenClawConfig();
    const agents = config.agents?.list ?? [];
    const bindings = config.bindings ?? [];
    const items = await Promise.all(
      agents.map(async (agent) => {
        const agentId = String(agent.id ?? "");
        const sessionsPath = path.join(env.openclawHome, "agents", agentId, "sessions", "sessions.json");
        const sessionCount = fs.existsSync(sessionsPath)
          ? Object.keys(await readJsonFile<Record<string, unknown>>(sessionsPath)).length
          : 0;
        const binding = bindings.find((entry) => entry.agentId === agentId && entry.match);
        return {
          id: agentId,
          workspace: agent.workspace ?? null,
          model: agent.model ?? config.agents?.defaults?.model ?? null,
          runtimeType: (agent.runtime as { type?: string } | undefined)?.type ?? "native",
          telegramBinding: binding ?? null,
          sessionCount,
        };
      }),
    );
    ok(res, items);
  }),
);

agentsRouter.get(
  "/auth-profiles",
  asyncHandler(async (_req, res) => {
    const profilesPath = path.join(env.openclawHome, "agents", "direct", "agent", "auth-profiles.json");
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
