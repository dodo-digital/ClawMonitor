import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Router } from "express";

import { env } from "../lib/env.js";
import { PROJECT_ROOT } from "../lib/constants.js";
import { asyncHandler, ok } from "../lib/http.js";
import { HttpError } from "../lib/errors.js";
import { readOpenClawConfig } from "../lib/openclaw.js";
import { atomicWriteJsonFile, readJsonFile } from "../lib/filesystem.js";
import { db } from "../lib/db.js";
import {
  computeComplianceScore,
  saveSecurityScan,
} from "../monitor/checks/security.js";

const execFileAsync = promisify(execFile);

export const setupRouter = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChecklistStatus = {
  agentConnected: boolean;
  skillInstalled: boolean;
  watchdogRunning: boolean;
  securityScanRun: boolean;
  notificationsConfigured: boolean;
  telegramBound: boolean;
};

type SetupStatus = {
  configured: boolean;
  agentId: string | null;
  backend: string | null;
  agentLive: boolean;
  needsGatewayRestart: boolean;
  detectedBackends: string[];
  checklist: ChecklistStatus;
  preflight: PreflightResult;
  issues: string[];
};

type ProvisionStep = {
  step: string;
  error: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_ID = "acp-clawmonitor";

// ---------------------------------------------------------------------------
// Pre-flight: is OpenClaw actually installed and reachable?
// ---------------------------------------------------------------------------

type PreflightResult = {
  openclawInstalled: boolean;
  openclawHome: boolean;
  configExists: boolean;
  gatewayReachable: boolean;
  issues: string[];
};

async function runPreflight(): Promise<PreflightResult> {
  const issues: string[] = [];

  // 1. Is the `openclaw` CLI in PATH?
  let openclawInstalled = false;
  try {
    await execFileAsync("openclaw", ["--version"], { timeout: 5000 });
    openclawInstalled = true;
  } catch {
    issues.push("OpenClaw CLI not found in PATH. Install it first: npm install -g openclaw");
  }

  // 2. Does ~/.openclaw exist?
  const openclawHome = fs.existsSync(env.openclawHome);
  if (!openclawHome) {
    issues.push(`OpenClaw home directory not found at ${env.openclawHome}. Run 'openclaw init' first.`);
  }

  // 3. Does openclaw.json exist?
  const configPath = path.join(env.openclawHome, "openclaw.json");
  const configExists = fs.existsSync(configPath);
  if (openclawHome && !configExists) {
    issues.push(`openclaw.json not found at ${configPath}. Run 'openclaw init' to create it.`);
  }

  // 4. Is the gateway reachable?
  let gatewayReachable = false;
  try {
    const response = await fetch(`${env.gatewayUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${env.gatewayToken}` },
      signal: AbortSignal.timeout(5000),
    });
    gatewayReachable = response.ok;
  } catch { /* not reachable */ }
  if (!gatewayReachable) {
    issues.push(`Gateway not reachable at ${env.gatewayUrl}. Start it with 'openclaw gateway start'.`);
  }

  return { openclawInstalled, openclawHome, configExists, gatewayReachable, issues };
}

async function detectBackends(): Promise<string[]> {
  try {
    const response = await fetch(`${env.gatewayUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${env.gatewayToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id) => id.startsWith("openclaw/acp-"))
      .map((id) => {
        // Extract backend from agent config, but for now just track agent IDs
        return id.replace("openclaw/", "");
      });
  } catch {
    return [];
  }
}

function findAgent(config: Record<string, unknown>): Record<string, unknown> | null {
  const agents = config.agents as { list?: Array<Record<string, unknown>> } | undefined;
  return agents?.list?.find((a) => a.id === AGENT_ID) ?? null;
}

function getAgentBackend(agent: Record<string, unknown> | null): string | null {
  if (!agent) return null;
  const model = agent.model as string | { primary?: string } | undefined;
  if (typeof model === "string") return model;
  if (model && typeof model === "object") return model.primary ?? null;
  return null;
}

async function checkSkillInstalled(): Promise<boolean> {
  const skillPath = path.join(env.openclawHome, "skills", "openclaw-ops");
  try {
    await fs.promises.access(skillPath);
    return true;
  } catch {
    return false;
  }
}

async function checkWatchdogRunning(): Promise<boolean> {
  // Check cron registry for gateway-watchdog
  try {
    const registryPath = path.join(env.openclawHome, "cron", "registry.yaml");
    const content = await fs.promises.readFile(registryPath, "utf8");
    return content.includes("gateway-watchdog");
  } catch {
    // Fall back to checking crontab
    try {
      const { stdout } = await execFileAsync("crontab", ["-l"]);
      return stdout.includes("watchdog");
    } catch {
      return false;
    }
  }
}

function checkSecurityScanRun(): boolean {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM security_scans")
    .get() as { count: number };
  return row.count > 0;
}

function checkNotificationsConfigured(): boolean {
  return Boolean(
    env.monitorTelegramBotToken ||
    env.monitorSlackWebhookUrl ||
    env.monitorEmailEndpoint ||
    env.monitorWebhookUrl,
  );
}

function findTelegramBinding(config: Record<string, unknown>): boolean {
  const bindings = config.bindings as Array<Record<string, unknown>> | undefined;
  if (!bindings) return false;
  return bindings.some((b) => b.agentId === AGENT_ID || b.agent_id === AGENT_ID);
}

// ---------------------------------------------------------------------------
// GET /status — detect what's configured
// ---------------------------------------------------------------------------

setupRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const preflight = await runPreflight();

    // If OpenClaw isn't installed or config doesn't exist, return early
    if (!preflight.configExists) {
      ok<SetupStatus>(res, {
        configured: false,
        agentId: null,
        backend: null,
        agentLive: false,
        needsGatewayRestart: false,
        detectedBackends: [],
        checklist: {
          agentConnected: false,
          skillInstalled: false,
          watchdogRunning: false,
          securityScanRun: false,
          notificationsConfigured: false,
          telegramBound: false,
        },
        preflight,
        issues: preflight.issues,
      });
      return;
    }

    const config = (await readOpenClawConfig()) as Record<string, unknown>;
    const agent = findAgent(config);
    const backend = getAgentBackend(agent);
    const detectedBackends = await detectBackends();

    // Check if the agent is actually live on the gateway (not just in config)
    const agentLive = detectedBackends.includes(AGENT_ID);
    // Agent is in config but gateway doesn't know about it yet
    const needsGatewayRestart = agent !== null && !agentLive && preflight.gatewayReachable;

    const checklist: ChecklistStatus = {
      agentConnected: agent !== null,
      skillInstalled: await checkSkillInstalled(),
      watchdogRunning: await checkWatchdogRunning(),
      securityScanRun: checkSecurityScanRun(),
      notificationsConfigured: checkNotificationsConfigured(),
      telegramBound: findTelegramBinding(config),
    };

    const issues: string[] = [...preflight.issues];
    if (!checklist.agentConnected) issues.push("Agent not configured in openclaw.json");
    if (!checklist.skillInstalled) issues.push("openclaw-ops skill not installed");
    if (!checklist.watchdogRunning) issues.push("Gateway watchdog cron not running");
    if (needsGatewayRestart) issues.push("Agent configured but gateway needs restart to load it");

    const configured = checklist.agentConnected && checklist.skillInstalled;

    ok<SetupStatus>(res, {
      configured,
      agentId: agent ? AGENT_ID : null,
      backend,
      agentLive,
      needsGatewayRestart,
      detectedBackends,
      checklist,
      preflight,
      issues,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /provision — auto-setup everything possible
// ---------------------------------------------------------------------------

setupRouter.post(
  "/provision",
  asyncHandler(async (_req, res) => {
    // Pre-flight: refuse to provision if OpenClaw isn't set up
    const preflight = await runPreflight();
    if (!preflight.openclawHome) {
      throw new HttpError(
        `OpenClaw is not installed. ${preflight.issues.join(" ")}`,
        422,
      );
    }
    if (!preflight.configExists) {
      throw new HttpError(
        `openclaw.json not found. Run 'openclaw init' first.`,
        422,
      );
    }

    const completed: string[] = [];
    const failed: ProvisionStep[] = [];

    const configPath = path.join(env.openclawHome, "openclaw.json");
    const config = (await readJsonFile<Record<string, unknown>>(configPath));

    // 1. Detect best backend
    let bestBackend = "claude";
    try {
      const response = await fetch(`${env.gatewayUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${env.gatewayToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const data = (await response.json()) as { data?: Array<{ id: string }> };
        const models = (data.data ?? []).map((m) => m.id);
        // Prefer claude backend
        if (models.some((m) => m.includes("claude"))) {
          bestBackend = "claude";
        } else if (models.length > 0) {
          // Extract backend name from first model
          const first = models[0];
          bestBackend = first.includes("/") ? first.split("/")[0] : first;
        }
      }
    } catch {
      // Use default "claude"
    }

    // 2. Add agent to config if not present
    try {
      const agents = (config.agents ?? { list: [], defaults: {} }) as {
        list: Array<Record<string, unknown>>;
        defaults: Record<string, unknown>;
      };
      config.agents = agents;
      if (!agents.list) agents.list = [];

      const existing = agents.list.find((a) => a.id === AGENT_ID);
      if (!existing) {
        // Find a reference agent to copy model config from
        const refAgent = agents.list.find((a) => a.id === "acp-claude") ?? agents.list[0];
        const modelConfig = refAgent?.model ?? bestBackend;

        agents.list.push({
          id: AGENT_ID,
          workspace: "default",
          model: modelConfig,
          runtimeType: "stateless",
        });
        await atomicWriteJsonFile(configPath, config);
        completed.push("agent config");
      } else {
        completed.push("agent config (already exists)");
      }
    } catch (err) {
      failed.push({ step: "agent config", error: (err as Error).message });
    }

    // 3. Create agent directories
    try {
      const agentBase = path.join(env.openclawHome, "agents", AGENT_ID);
      await fs.promises.mkdir(path.join(agentBase, "agent"), { recursive: true });
      await fs.promises.mkdir(path.join(agentBase, "sessions"), { recursive: true });
      completed.push("directories");
    } catch (err) {
      failed.push({ step: "directories", error: (err as Error).message });
    }

    // 4. Copy auth-profiles.json from a reference agent
    try {
      const agentBase = path.join(env.openclawHome, "agents", AGENT_ID);
      const authDest = path.join(agentBase, "auth-profiles.json");
      if (!fs.existsSync(authDest)) {
        // Try to find auth profiles from direct agent or any existing agent
        const agentsDir = path.join(env.openclawHome, "agents");
        const candidates = ["direct", "acp-claude"];
        let copied = false;
        for (const candidate of candidates) {
          const src = path.join(agentsDir, candidate, "auth-profiles.json");
          if (fs.existsSync(src)) {
            // Symlink instead of copy so updates propagate
            await fs.promises.symlink(src, authDest);
            copied = true;
            break;
          }
        }
        if (copied) {
          completed.push("auth profiles");
        } else {
          completed.push("auth profiles (no source found, skipped)");
        }
      } else {
        completed.push("auth profiles (already exists)");
      }
    } catch (err) {
      failed.push({ step: "auth profiles", error: (err as Error).message });
    }

    // 5. Symlink openclaw-ops skill
    try {
      const skillDest = path.join(env.openclawHome, "skills", "openclaw-ops");
      const skillSrc = path.join(PROJECT_ROOT, "skills", "openclaw-ops");

      if (!fs.existsSync(skillDest)) {
        if (fs.existsSync(skillSrc)) {
          await fs.promises.mkdir(path.join(env.openclawHome, "skills"), { recursive: true });
          await fs.promises.symlink(skillSrc, skillDest);
          completed.push("skill symlink");
        } else {
          completed.push("skill symlink (source not found, skipped)");
        }
      } else {
        completed.push("skill symlink (already exists)");
      }
    } catch (err) {
      failed.push({ step: "skill symlink", error: (err as Error).message });
    }

    // 6. Register watchdog cron job
    try {
      const registryPath = path.join(env.openclawHome, "cron", "registry.yaml");
      let hasWatchdog = false;
      try {
        const content = await fs.promises.readFile(registryPath, "utf8");
        hasWatchdog = content.includes("gateway-watchdog");
      } catch { /* file doesn't exist */ }

      if (!hasWatchdog) {
        // Try registering via cron-cli
        try {
          await execFileAsync("cron-cli", [
            "add",
            "--id", "gateway-watchdog",
            "--name", "Gateway Watchdog",
            "--schedule", "*/5 * * * *",
            "--command", `bash ${path.join(PROJECT_ROOT, "server", "scripts", "watchdog.sh")}`,
            "--category", "system",
            "--description", "Health check and auto-restart for OpenClaw gateway",
          ], { timeout: 10000 });
          completed.push("watchdog cron");
        } catch (cronErr) {
          failed.push({ step: "watchdog cron", error: `cron-cli failed: ${(cronErr as Error).message}` });
        }
      } else {
        completed.push("watchdog cron (already registered)");
      }
    } catch (err) {
      failed.push({ step: "watchdog cron", error: (err as Error).message });
    }

    // 7. Run security scan
    try {
      const row = db
        .prepare("SELECT COUNT(*) as count FROM security_scans")
        .get() as { count: number };
      if (row.count === 0) {
        const report = await computeComplianceScore();
        saveSecurityScan(report);
        completed.push("security scan");
      } else {
        completed.push("security scan (already exists)");
      }
    } catch (err) {
      failed.push({ step: "security scan", error: (err as Error).message });
    }

    const success = failed.length === 0;
    const note = success
      ? "Setup complete. Restart the gateway to activate the agent: openclaw gateway restart"
      : `Setup partially complete. ${failed.length} step(s) failed — see details.`;

    ok(res, { success, completed, failed, note });
  }),
);

// ---------------------------------------------------------------------------
// POST /test — ping the agent
// ---------------------------------------------------------------------------

setupRouter.post(
  "/test",
  asyncHandler(async (_req, res) => {
    const start = Date.now();

    try {
      const response = await fetch(`${env.gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.gatewayToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: `openclaw/${AGENT_ID}`,
          messages: [
            { role: "user", content: "ping — respond with OK and your agent ID" },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });

      const latencyMs = Date.now() - start;

      if (!response.ok) {
        const body = await response.text();
        throw new HttpError(`Agent returned ${response.status}: ${body.slice(0, 200)}`, 502);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "No response content";

      ok(res, { success: true, response: content, latencyMs });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const latencyMs = Date.now() - start;
      ok(res, {
        success: false,
        response: (err as Error).message,
        latencyMs,
      });
    }
  }),
);
