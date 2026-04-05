import { Router } from "express";

import { db } from "../lib/db.js";
import { asyncHandler, ok } from "../lib/http.js";
import { readOpenClawConfig } from "../lib/openclaw.js";
import {
  computeComplianceScore,
  getLatestSecurityScan,
  getSecurityHistory,
  saveSecurityBaseline,
  saveSecurityScan,
} from "../monitor/checks/security.js";

export const securityRouter = Router();

// ---------------------------------------------------------------------------
// Access Surface — what doors are open into this system?
// ---------------------------------------------------------------------------

type ChannelRisk = "low" | "medium" | "high";

function assessDmRisk(policy: string | undefined): ChannelRisk {
  if (!policy || policy === "open") return "high";
  if (policy === "pairing") return "medium";
  return "low"; // allowlist, closed, etc.
}

securityRouter.get(
  "/access-surface",
  asyncHandler(async (_req, res) => {
    // Cast to Record — the typed OpenClawConfig doesn't cover channels/hooks/gateway
    const config = (await readOpenClawConfig()) as unknown as Record<string, unknown>;
    const channelsConfig = (config.channels ?? {}) as Record<string, Record<string, unknown>>;
    const bindings = (config.bindings ?? []) as Array<{ agentId?: string; match?: { channel?: string } }>;
    const hooksConfig = (config.hooks ?? {}) as Record<string, unknown>;

    // Build channel list
    const channels = Object.entries(channelsConfig)
      .filter(([, cfg]) => typeof cfg === "object" && cfg !== null)
      .map(([name, cfg]) => {
        const enabled = Boolean(cfg.enabled);
        const dmPolicy = String(cfg.dmPolicy ?? cfg.dm_policy ?? "unknown");
        const groupPolicy = String(cfg.groupPolicy ?? cfg.group_policy ?? "unknown");

        // Count allowed users — OpenClaw uses "allowFrom" for allowlists
        const allowlist = cfg.allowFrom ?? cfg.allowlist ?? cfg.dmAllowlist;
        const hasWildcard = Array.isArray(allowlist) && allowlist.some((v: unknown) => v === "*");
        const allowedUsers = hasWildcard
          ? null  // wildcard = everyone
          : Array.isArray(allowlist) ? allowlist.length : (dmPolicy === "open" ? null : undefined);

        // Find agents bound to this channel
        const boundAgents = bindings
          .filter((b) => b.match?.channel === name)
          .map((b) => b.agentId ?? "unknown");

        return {
          name,
          enabled,
          dmPolicy,
          groupPolicy,
          allowedUsers: allowedUsers ?? null,
          boundAgents,
          risk: enabled ? assessDmRisk(dmPolicy) : ("low" as ChannelRisk),
        };
      });

    // Build webhook list
    const hookMappings = (hooksConfig.mappings ?? []) as Array<{
      match?: { path?: string };
      name?: string;
      transform?: { module?: string };
    }>;
    const webhooks = hookMappings.map((m) => ({
      path: `/hooks/${m.match?.path ?? "unknown"}`,
      name: m.name ?? m.match?.path ?? "unnamed",
      transform: m.transform?.module ?? null,
      hasToken: Boolean(hooksConfig.token),
    }));

    // Gateway summary
    const gatewayConfig = (config.gateway ?? {}) as Record<string, unknown>;
    const authConfig = (gatewayConfig.auth ?? {}) as Record<string, unknown>;
    const tailscaleConfig = (config.tailscale ?? {}) as Record<string, unknown>;
    const trustedProxies = (gatewayConfig.trustedProxies ?? []) as unknown[];

    const gateway = {
      bind: String(gatewayConfig.bind ?? "unknown"),
      authMode: String(authConfig.mode ?? "unknown"),
      tailscale: Boolean(tailscaleConfig.mode || tailscaleConfig.serve),
      trustedProxies: trustedProxies.length,
    };

    // Exec security
    const toolsExec = ((config.tools ?? {}) as Record<string, unknown>).exec as Record<string, unknown> | undefined;
    const execSecurity = String(toolsExec?.security ?? "unknown");

    // Counts
    const agentsList = ((config.agents ?? {}) as Record<string, unknown>).list as unknown[] | undefined;
    const agentCount = agentsList?.length ?? 0;

    ok(res, {
      channels,
      webhooks,
      hooksEnabled: Boolean(hooksConfig.enabled),
      gateway,
      execSecurity,
      agentCount,
      totalBindings: bindings.length,
    });
  }),
);

// ---------------------------------------------------------------------------
// Activity — what's flowing through those doors?
// ---------------------------------------------------------------------------

securityRouter.get(
  "/activity",
  asyncHandler(async (_req, res) => {
    // Sessions, messages, tool calls grouped by channel for 24h and 7d
    const byChannel24h = db
      .prepare(
        `SELECT channel,
                COUNT(DISTINCT session_key) AS sessions,
                SUM(message_count) AS messages,
                MAX(updated_at) AS last_activity
         FROM sessions
         WHERE updated_at > datetime('now', '-24 hours')
         GROUP BY channel`,
      )
      .all() as Array<{ channel: string; sessions: number; messages: number; last_activity: string }>;

    const byChannel7d = db
      .prepare(
        `SELECT channel,
                COUNT(DISTINCT session_key) AS sessions,
                SUM(message_count) AS messages,
                MAX(updated_at) AS last_activity
         FROM sessions
         WHERE updated_at > datetime('now', '-7 days')
         GROUP BY channel`,
      )
      .all() as Array<{ channel: string; sessions: number; messages: number; last_activity: string }>;

    const toolCalls24h = db
      .prepare(
        `SELECT channel, COUNT(*) AS count
         FROM tool_calls
         WHERE timestamp > datetime('now', '-24 hours')
         GROUP BY channel`,
      )
      .all() as Array<{ channel: string; count: number }>;

    const toolCalls7d = db
      .prepare(
        `SELECT channel, COUNT(*) AS count
         FROM tool_calls
         WHERE timestamp > datetime('now', '-7 days')
         GROUP BY channel`,
      )
      .all() as Array<{ channel: string; count: number }>;

    // Unique sources (agent_id) per channel in 24h
    const senders24h = db
      .prepare(
        `SELECT channel, COUNT(DISTINCT agent_id) AS unique_senders
         FROM sessions
         WHERE updated_at > datetime('now', '-24 hours')
         GROUP BY channel`,
      )
      .all() as Array<{ channel: string; unique_senders: number }>;

    // Top tools per channel (7d)
    const topTools = db
      .prepare(
        `SELECT channel, tool_name, COUNT(*) AS cnt
         FROM tool_calls
         WHERE timestamp > datetime('now', '-7 days')
         GROUP BY channel, tool_name
         ORDER BY channel, cnt DESC`,
      )
      .all() as Array<{ channel: string; tool_name: string; cnt: number }>;

    // Merge into a single structure
    const allChannels = new Set([
      ...byChannel24h.map((r) => r.channel),
      ...byChannel7d.map((r) => r.channel),
    ]);

    const tc24hMap = new Map(toolCalls24h.map((r) => [r.channel, r.count]));
    const tc7dMap = new Map(toolCalls7d.map((r) => [r.channel, r.count]));
    const sendersMap = new Map(senders24h.map((r) => [r.channel, r.unique_senders]));
    const map24h = new Map(byChannel24h.map((r) => [r.channel, r]));
    const map7d = new Map(byChannel7d.map((r) => [r.channel, r]));

    // Group top tools per channel (max 5)
    const topToolsByChannel = new Map<string, string[]>();
    for (const row of topTools) {
      const existing = topToolsByChannel.get(row.channel) ?? [];
      if (existing.length < 5) existing.push(row.tool_name);
      topToolsByChannel.set(row.channel, existing);
    }

    const byChannel = [...allChannels].map((channel) => {
      const d24 = map24h.get(channel);
      const d7 = map7d.get(channel);
      return {
        channel,
        sessions24h: d24?.sessions ?? 0,
        messages24h: d24?.messages ?? 0,
        toolCalls24h: tc24hMap.get(channel) ?? 0,
        sessions7d: d7?.sessions ?? 0,
        messages7d: d7?.messages ?? 0,
        toolCalls7d: tc7dMap.get(channel) ?? 0,
        lastActivity: d7?.last_activity ?? d24?.last_activity ?? null,
        uniqueSenders24h: sendersMap.get(channel) ?? 0,
        topTools: topToolsByChannel.get(channel) ?? [],
      };
    });

    // Sort: most active first
    byChannel.sort((a, b) => b.messages7d - a.messages7d);

    ok(res, { byChannel });
  }),
);

// ---------------------------------------------------------------------------
// Compliance scan (existing)
// ---------------------------------------------------------------------------

securityRouter.get(
  "/scan",
  asyncHandler(async (_req, res) => {
    const report = await computeComplianceScore();
    saveSecurityScan(report);
    ok(res, report);
  }),
);

securityRouter.get(
  "/latest",
  asyncHandler(async (_req, res) => {
    ok(res, getLatestSecurityScan());
  }),
);

securityRouter.get(
  "/history",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    ok(res, { items: getSecurityHistory(limit) });
  }),
);

securityRouter.post(
  "/baseline",
  asyncHandler(async (_req, res) => {
    const result = await saveSecurityBaseline();
    ok(res, result);
  }),
);
