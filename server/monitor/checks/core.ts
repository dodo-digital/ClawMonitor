import fs from "node:fs";
import path from "node:path";

import { env } from "../../lib/env.js";
import { getDiskUsage } from "../../lib/system-info.js";
import { readJsonFile } from "../../lib/filesystem.js";
import { readOpenClawConfig } from "../../lib/openclaw.js";
import {
  estimateScheduleIntervalMs,
  getRegistryJobLastObservedAt,
  getRegistryRunHistory,
  readCronRegistry,
  type RegistryJob,
} from "../cron-registry.js";
import { getGatewayState } from "../runtime-state.js";
import { DEFAULT_WORKSPACE_ID } from "../workspace.js";
import type { MonitorCheckResultInput } from "../types.js";

// ---------------------------------------------------------------------------
// Types for exec security configs
// ---------------------------------------------------------------------------

type ExecApprovalsFile = {
  defaults?: {
    security?: string;
    ask?: string;
    askFallback?: string;
  };
  agents?: Record<string, { allowlist?: Array<{ pattern: string }> }>;
};

type OpenClawToolsExec = {
  security?: string;
  strictInlineEval?: boolean;
  ask?: string;
};

type OpenClawJsonForExec = {
  tools?: {
    exec?: OpenClawToolsExec;
  };
};

function buildCheckResult(input: Omit<MonitorCheckResultInput, "workspaceId" | "observedAt">): MonitorCheckResultInput {
  return {
    workspaceId: DEFAULT_WORKSPACE_ID,
    observedAt: new Date().toISOString(),
    ...input,
  };
}

function minsAgo(iso: string | null): number | null {
  if (!iso) {
    return null;
  }

  const diffMs = Date.now() - Date.parse(iso);
  return Math.round(diffMs / 60_000);
}

export async function runGatewayCheck(): Promise<MonitorCheckResultInput> {
  const state = getGatewayState();
  const authFailureMinutes = minsAgo(state.lastAuthFailureAt);

  if (
    state.status !== "connected" &&
    !state.lastConnectedAt &&
    !state.lastAuthSuccessAt &&
    !state.lastDisconnectedAt
  ) {
    return buildCheckResult({
      checkType: "gateway.connection",
      targetKey: "gateway",
      status: "unknown",
      severity: "warning",
      summary: "Gateway bridge is still establishing its first connection",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:gateway.connection:gateway:bootstrapping`,
      title: "Gateway still connecting",
      evidence: state,
    });
  }

  if (state.status !== "connected") {
    return buildCheckResult({
      checkType: "gateway.connection",
      targetKey: "gateway",
      status: "failing",
      severity: "critical",
      summary: "Gateway bridge is disconnected",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:gateway.connection:gateway:disconnected`,
      title: "Gateway disconnected",
      evidence: state,
    });
  }

  if (
    authFailureMinutes !== null &&
    (!state.lastAuthSuccessAt || Date.parse(state.lastAuthSuccessAt) < Date.parse(state.lastAuthFailureAt!))
  ) {
    return buildCheckResult({
      checkType: "gateway.connection",
      targetKey: "gateway",
      status: "failing",
      severity: "critical",
      summary: "Gateway authentication is failing",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:gateway.connection:gateway:auth_rejected`,
      title: "Gateway auth rejected",
      evidence: state,
    });
  }

  return buildCheckResult({
    checkType: "gateway.connection",
    targetKey: "gateway",
    status: "healthy",
    severity: "info",
    summary: "Gateway bridge is connected",
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:gateway.connection:gateway:healthy`,
    title: "Gateway connected",
    evidence: state,
  });
}

async function buildCronStatusCheck(job: RegistryJob): Promise<MonitorCheckResultInput> {
  const runs = await getRegistryRunHistory(job, 1);
  const lastRun = runs[0];

  if (!lastRun) {
    // Linux-layer jobs don't write JSONL run history — skip status check for them.
    // Their health is tracked via staleness (log file modification time) instead.
    if (job.layer === "linux") {
      return buildCheckResult({
        checkType: "cron.job_status",
        targetKey: job.id,
        status: "healthy",
        severity: "info",
        summary: `${job.name} is a system cron job (status tracked via log staleness)`,
        dedupeKey: `${DEFAULT_WORKSPACE_ID}:cron.job_status:${job.id}:healthy`,
        title: `${job.name} (system cron)`,
        evidence: { job, lastRun: null, note: "Linux-layer jobs use log-based staleness tracking" },
      });
    }

    return buildCheckResult({
      checkType: "cron.job_status",
      targetKey: job.id,
      status: "unknown",
      severity: "warning",
      summary: `${job.name} has no recorded runs`,
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:cron.job_status:${job.id}:missing_runs`,
      title: `${job.name} has no runs`,
      evidence: { job, lastRun: null },
    });
  }

  if (lastRun.status !== "ok") {
    return buildCheckResult({
      checkType: "cron.job_status",
      targetKey: job.id,
      status: "failing",
      severity: "critical",
      summary: `${job.name} last run failed with status ${lastRun.status}`,
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:cron.job_status:${job.id}:status_${lastRun.status}`,
      title: `${job.name} is failing`,
      evidence: { job, lastRun },
    });
  }

  return buildCheckResult({
    checkType: "cron.job_status",
    targetKey: job.id,
    status: "healthy",
    severity: "info",
    summary: `${job.name} last run succeeded`,
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:cron.job_status:${job.id}:healthy`,
    title: `${job.name} is healthy`,
    evidence: { job, lastRun },
  });
}

async function buildCronStalenessCheck(job: RegistryJob): Promise<MonitorCheckResultInput> {
  const intervalMs = estimateScheduleIntervalMs(job.schedule);
  const observedAtMs = await getRegistryJobLastObservedAt(job);

  if (!observedAtMs) {
    return buildCheckResult({
      checkType: "cron.job_staleness",
      targetKey: job.id,
      status: "healthy",
      severity: "info",
      summary: `${job.name} has no recorded runs yet — staleness tracking starts after first run`,
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:cron.job_staleness:${job.id}:never_run`,
      title: `${job.name} has not run yet`,
      evidence: { job, observedAtMs: null, intervalMs },
    });
  }

  const toleratedMs = intervalMs ? intervalMs * 2 : 24 * 60 * 60_000;
  const staleMs = Date.now() - observedAtMs;

  if (staleMs > toleratedMs) {
    return buildCheckResult({
      checkType: "cron.job_staleness",
      targetKey: job.id,
      status: "failing",
      severity: "critical",
      summary: `${job.name} has not updated within its expected window`,
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:cron.job_staleness:${job.id}:stale`,
      title: `${job.name} is stale`,
      evidence: { job, observedAtMs, intervalMs, staleMs, toleratedMs },
    });
  }

  return buildCheckResult({
    checkType: "cron.job_staleness",
    targetKey: job.id,
    status: "healthy",
    severity: "info",
    summary: `${job.name} is running on schedule`,
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:cron.job_staleness:${job.id}:healthy`,
    title: `${job.name} is current`,
    evidence: { job, observedAtMs, intervalMs, staleMs, toleratedMs },
  });
}

export async function runCronStatusChecks(): Promise<MonitorCheckResultInput[]> {
  const registry = await readCronRegistry();
  const jobs = registry.jobs.filter((job) => job.enabled);
  return Promise.all(jobs.map((job) => buildCronStatusCheck(job)));
}

export async function runCronStalenessChecks(): Promise<MonitorCheckResultInput[]> {
  const registry = await readCronRegistry();
  const jobs = registry.jobs.filter((job) => job.enabled);
  return Promise.all(jobs.map((job) => buildCronStalenessCheck(job)));
}

export async function runDiskCheck(): Promise<MonitorCheckResultInput> {
  const disk = await getDiskUsage();

  if (disk.usePercent >= 95) {
    return buildCheckResult({
      checkType: "system.disk",
      targetKey: disk.mount,
      status: "failing",
      severity: "critical",
      summary: `Disk usage is at ${disk.usePercent}%`,
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:system.disk:${disk.mount}:critical`,
      title: "Disk usage critical",
      evidence: disk,
    });
  }

  if (disk.usePercent >= 85) {
    return buildCheckResult({
      checkType: "system.disk",
      targetKey: disk.mount,
      status: "degraded",
      severity: "warning",
      summary: `Disk usage is at ${disk.usePercent}%`,
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:system.disk:${disk.mount}:warning`,
      title: "Disk usage elevated",
      evidence: disk,
    });
  }

  return buildCheckResult({
    checkType: "system.disk",
    targetKey: disk.mount,
    status: "healthy",
    severity: "info",
    summary: `Disk usage is at ${disk.usePercent}%`,
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:system.disk:${disk.mount}:healthy`,
    title: "Disk usage healthy",
    evidence: disk,
  });
}

export async function runAuthProfilesCheck(): Promise<MonitorCheckResultInput> {
  // Resolve the primary native agent instead of hardcoding "direct"
  let primaryAgent = "direct";
  try {
    const config = await readOpenClawConfig();
    const agents = config.agents?.list ?? [];
    const native = agents.find((a) => {
      const rt = (a.runtime as { type?: string } | undefined)?.type;
      return !rt || rt === "native";
    });
    if (native?.id) primaryAgent = String(native.id);
  } catch { /* fall back to "direct" */ }
  const profilesPath = path.join(env.openclawHome, "agents", primaryAgent, "agent", "auth-profiles.json");

  if (!fs.existsSync(profilesPath)) {
    return buildCheckResult({
      checkType: "auth.profile_integrity",
      targetKey: "direct-agent",
      status: "failing",
      severity: "critical",
      summary: "Auth profiles file is missing",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:auth.profile_integrity:direct-agent:missing_file`,
      title: "Auth profiles missing",
      evidence: { profilesPath },
    });
  }

  const authProfiles = await readJsonFile<{
    profiles?: Record<string, { key?: string; access?: string; provider?: string; type?: string }>;
  }>(profilesPath);
  const profiles = Object.entries(authProfiles.profiles ?? {});
  const invalidProfiles = profiles
    .filter(([, profile]) => !(profile.provider && profile.type && (profile.key || profile.access)))
    .map(([name, profile]) => ({ name, profile }));

  if (profiles.length === 0 || invalidProfiles.length > 0) {
    return buildCheckResult({
      checkType: "auth.profile_integrity",
      targetKey: "direct-agent",
      status: "failing",
      severity: "critical",
      summary: invalidProfiles.length > 0 ? "One or more auth profiles are malformed" : "No auth profiles are configured",
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:auth.profile_integrity:direct-agent:${invalidProfiles.length > 0 ? "malformed" : "empty"}`,
      title: "Auth profiles invalid",
      evidence: {
        profilesCount: profiles.length,
        invalidProfiles,
      },
    });
  }

  return buildCheckResult({
    checkType: "auth.profile_integrity",
    targetKey: "direct-agent",
    status: "healthy",
    severity: "info",
    summary: `${profiles.length} auth profiles passed integrity checks`,
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:auth.profile_integrity:direct-agent:healthy`,
    title: "Auth profiles healthy",
    evidence: {
      profilesCount: profiles.length,
      profileNames: profiles.map(([name]) => name),
    },
  });
}

// ---------------------------------------------------------------------------
// Exec Security Check
// ---------------------------------------------------------------------------

export type ExecSecurityStatus = {
  settings: {
    gatewayExecSecurity: string | null;
    gatewayExecAsk: string | null;
    gatewayStrictInlineEval: boolean | null;
    approvalsDefaultSecurity: string | null;
    approvalsDefaultAsk: string | null;
    approvalsDefaultAskFallback: string | null;
    approvalsHasWildcard: boolean;
  };
  cronReady: boolean;
  cronBlockers: string[];
};

export async function readExecSecurityStatus(): Promise<ExecSecurityStatus> {
  // Read openclaw.json tools.exec
  let toolsExec: OpenClawToolsExec = {};
  try {
    const config = await readJsonFile<OpenClawJsonForExec>(path.join(env.openclawHome, "openclaw.json"));
    toolsExec = config.tools?.exec ?? {};
  } catch {
    // file missing or unreadable
  }

  // Read exec-approvals.json
  let approvals: ExecApprovalsFile = {};
  try {
    approvals = await readJsonFile<ExecApprovalsFile>(path.join(env.openclawHome, "exec-approvals.json"));
  } catch {
    // file missing or unreadable
  }

  const defaults = approvals.defaults ?? {};
  const globalAgent = approvals.agents?.["*"];
  const hasWildcard = globalAgent?.allowlist?.some((entry) => entry.pattern === "*") ?? false;

  const settings: ExecSecurityStatus["settings"] = {
    gatewayExecSecurity: toolsExec.security ?? null,
    gatewayExecAsk: toolsExec.ask ?? null,
    gatewayStrictInlineEval: toolsExec.strictInlineEval ?? null,
    approvalsDefaultSecurity: defaults.security ?? null,
    approvalsDefaultAsk: defaults.ask ?? null,
    approvalsDefaultAskFallback: defaults.askFallback ?? null,
    approvalsHasWildcard: hasWildcard,
  };

  // Determine if cron jobs can run unblocked
  const cronBlockers: string[] = [];

  if (settings.gatewayExecSecurity === "deny") {
    cronBlockers.push("Gateway security is set to \"deny\" — no commands can run at all");
  } else if (settings.gatewayExecSecurity === "allowlist") {
    cronBlockers.push("Gateway security is set to \"allowlist\" — only pre-approved commands will run, complex commands (pipes, chaining) may be blocked");
  } else if (settings.gatewayExecSecurity !== "full") {
    cronBlockers.push("Gateway security is not configured — commands may be blocked by default");
  }

  if (settings.approvalsDefaultSecurity === "deny") {
    cronBlockers.push("Approval daemon security is set to \"deny\" — all exec requests will be rejected");
  } else if (settings.approvalsDefaultSecurity === "allowlist" && !hasWildcard) {
    cronBlockers.push("Approval daemon uses allowlist mode but no wildcard pattern exists — only specifically approved commands will run");
  }

  if (settings.approvalsDefaultAsk === "on-miss" || settings.approvalsDefaultAsk === "always") {
    const fallback = settings.approvalsDefaultAskFallback;
    if (fallback === "deny") {
      cronBlockers.push("Approval prompts are enabled and fallback is \"deny\" — unapproved commands will silently fail when nobody has the Control UI open");
    } else if (fallback !== "full" && fallback !== null) {
      cronBlockers.push("Approval prompts are enabled — unapproved commands depend on the fallback setting when the Control UI isn't open");
    }
    // If fallback is "full", cron jobs will still run even with prompts enabled — no blocker needed
  }

  return {
    settings,
    cronReady: cronBlockers.length === 0,
    cronBlockers,
  };
}

export type ExecSecurityUpdate = {
  gatewayExecSecurity?: string;
  gatewayExecAsk?: string;
  gatewayStrictInlineEval?: boolean;
  approvalsDefaultSecurity?: string;
  approvalsDefaultAsk?: string;
  approvalsDefaultAskFallback?: string;
};

export async function writeExecSecuritySettings(update: ExecSecurityUpdate): Promise<void> {
  const openclawJsonPath = path.join(env.openclawHome, "openclaw.json");
  const approvalsPath = path.join(env.openclawHome, "exec-approvals.json");

  // Update openclaw.json tools.exec
  if (
    update.gatewayExecSecurity !== undefined ||
    update.gatewayExecAsk !== undefined ||
    update.gatewayStrictInlineEval !== undefined
  ) {
    const config = await readJsonFile<Record<string, unknown>>(openclawJsonPath);
    const tools = (config.tools ?? {}) as Record<string, unknown>;
    const exec = (tools.exec ?? {}) as Record<string, unknown>;

    if (update.gatewayExecSecurity !== undefined) exec.security = update.gatewayExecSecurity;
    if (update.gatewayExecAsk !== undefined) exec.ask = update.gatewayExecAsk;
    if (update.gatewayStrictInlineEval !== undefined) exec.strictInlineEval = update.gatewayStrictInlineEval;

    tools.exec = exec;
    config.tools = tools;
    await fs.promises.writeFile(openclawJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  // Update exec-approvals.json defaults
  if (
    update.approvalsDefaultSecurity !== undefined ||
    update.approvalsDefaultAsk !== undefined ||
    update.approvalsDefaultAskFallback !== undefined
  ) {
    const approvals = await readJsonFile<Record<string, unknown>>(approvalsPath);
    const defaults = (approvals.defaults ?? {}) as Record<string, unknown>;

    if (update.approvalsDefaultSecurity !== undefined) defaults.security = update.approvalsDefaultSecurity;
    if (update.approvalsDefaultAsk !== undefined) defaults.ask = update.approvalsDefaultAsk;
    if (update.approvalsDefaultAskFallback !== undefined) defaults.askFallback = update.approvalsDefaultAskFallback;

    approvals.defaults = defaults;
    await fs.promises.writeFile(approvalsPath, `${JSON.stringify(approvals, null, 2)}\n`, "utf8");
  }
}

export async function runExecSecurityCheck(): Promise<MonitorCheckResultInput> {
  const status = await readExecSecurityStatus();

  if (!status.cronReady) {
    return buildCheckResult({
      checkType: "exec.security_config",
      targetKey: "exec-security",
      status: "failing",
      severity: "critical",
      summary: `Cron jobs may fail: ${status.cronBlockers[0]}`,
      dedupeKey: `${DEFAULT_WORKSPACE_ID}:exec.security_config:exec-security:cron_blocked`,
      title: "Exec settings may block cron jobs",
      evidence: status,
    });
  }

  return buildCheckResult({
    checkType: "exec.security_config",
    targetKey: "exec-security",
    status: "healthy",
    severity: "info",
    summary: "Exec security settings allow cron jobs to run",
    dedupeKey: `${DEFAULT_WORKSPACE_ID}:exec.security_config:exec-security:healthy`,
    title: "Exec security healthy",
    evidence: status,
  });
}
