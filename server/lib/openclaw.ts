import fs from "node:fs";
import path from "node:path";

import { env } from "./env.js";
import { readJsonFile } from "./filesystem.js";

type OpenClawConfig = {
  meta?: { lastTouchedVersion?: string; lastTouchedAt?: string };
  acp?: Record<string, unknown>;
  bindings?: Array<Record<string, unknown>>;
  agents?: {
    list?: Array<Record<string, unknown>>;
    defaults?: Record<string, unknown>;
  };
};

export async function readOpenClawConfig(): Promise<OpenClawConfig> {
  return readJsonFile<OpenClawConfig>(path.join(env.openclawHome, "openclaw.json"));
}

export function summarizeConfig(config: OpenClawConfig): Record<string, unknown> {
  const defaults = config.agents?.defaults ?? {};
  return {
    version: config.meta?.lastTouchedVersion ?? null,
    lastTouchedAt: config.meta?.lastTouchedAt ?? null,
    acpEnabled: Boolean(config.acp && (config.acp as { enabled?: boolean }).enabled),
    agentCount: config.agents?.list?.length ?? 0,
    defaultWorkspace: (defaults as { workspace?: string }).workspace ?? null,
    memorySources: ((defaults as { memorySearch?: { sources?: string[] } }).memorySearch?.sources) ?? [],
    bindingCount: config.bindings?.length ?? 0,
  };
}

export function listAgentBindings(config: OpenClawConfig): Array<Record<string, unknown>> {
  return config.bindings ?? [];
}

export function getBootstrapFilePath(name: string): string {
  return path.join(env.workspaceDir, name);
}

export function bootstrapFileExists(name: string): boolean {
  return fs.existsSync(getBootstrapFilePath(name));
}

export async function getExtraPaths(): Promise<string[]> {
  const config = await readOpenClawConfig();
  const defaults = config.agents?.defaults as Record<string, unknown> | undefined;
  const memorySearch = defaults?.memorySearch as Record<string, unknown> | undefined;
  const extraPaths = memorySearch?.extraPaths as string[] | undefined;
  return extraPaths ?? [];
}

/** Resolve the workspace directory for a specific agent. Falls back to the default workspace. */
export async function getAgentWorkspace(agentId: string): Promise<string> {
  const config = await readOpenClawConfig();
  const agents = config.agents?.list ?? [];
  const agent = agents.find((a) => String(a.id ?? "") === agentId);
  if (agent?.workspace && typeof agent.workspace === "string") {
    return agent.workspace;
  }
  const defaults = config.agents?.defaults as Record<string, unknown> | undefined;
  return (defaults?.workspace as string) ?? env.workspaceDir;
}

/** Get extra paths for a specific agent's memory search config. */
export async function getAgentExtraPaths(agentId: string): Promise<string[]> {
  const config = await readOpenClawConfig();
  const agents = config.agents?.list ?? [];
  const agent = agents.find((a) => String(a.id ?? "") === agentId);

  // Check agent-level memorySearch.extraPaths first
  const agentMs = (agent as Record<string, unknown> | undefined)?.memorySearch as Record<string, unknown> | undefined;
  if (agentMs?.extraPaths && Array.isArray(agentMs.extraPaths)) {
    return agentMs.extraPaths as string[];
  }

  // Fall back to defaults
  const defaults = config.agents?.defaults as Record<string, unknown> | undefined;
  const memorySearch = defaults?.memorySearch as Record<string, unknown> | undefined;
  return (memorySearch?.extraPaths as string[] | undefined) ?? [];
}
