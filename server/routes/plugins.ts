import { execFile } from "node:child_process";
import { Router } from "express";

import { asyncHandler, ok } from "../lib/http.js";

export const pluginsRouter = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PluginRaw = {
  id: string;
  name: string;
  description: string;
  version: string | null;
  origin: "bundled" | "global" | "custom";
  enabled: boolean;
  status: string;
  toolNames: string[];
  hookNames: string[];
  channelIds: string[];
  providerIds: string[];
  speechProviderIds: string[];
  imageGenerationProviderIds: string[];
  webSearchProviderIds: string[];
  webFetchProviderIds: string[];
  mediaUnderstandingProviderIds: string[];
  cliCommands: string[];
  services: string[];
  commands: string[];
  httpRoutes: number;
  hookCount: number;
  configSchema: boolean;
  configUiHints?: Record<string, unknown>;
  activationSource?: string;
  activationReason?: string;
  rootDir?: string;
};

type PluginListResponse = {
  workspaceDir: string;
  plugins: PluginRaw[];
};

export type PluginSummary = {
  id: string;
  name: string;
  description: string;
  version: string | null;
  origin: "bundled" | "global" | "custom";
  enabled: boolean;
  status: string;
  category: string;
  capabilities: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Known plugin IDs by category (the CLI capability arrays are often empty,
// so we categorize by ID + name patterns instead)
const CHANNEL_IDS = new Set([
  "telegram", "slack", "discord", "matrix", "irc", "imessage",
  "line", "feishu", "googlechat", "bluebubbles", "mattermost",
  "msteams", "nextcloud-talk", "nostr", "qqbot", "signal",
  "synology-chat", "tlon", "twitch", "whatsapp", "zalo", "zalouser",
]);
const SEARCH_IDS = new Set([
  "brave", "duckduckgo", "exa", "firecrawl", "google-search",
  "perplexity", "searxng", "tavily", "google",
]);
const SPEECH_IDS = new Set(["deepgram", "elevenlabs", "microsoft"]);
const IMAGE_IDS = new Set(["fal"]);
const RUNTIME_IDS = new Set([
  "acpx", "diagnostics-otel", "device-pair", "package",
  "browser", "openshell", "voice-call",
]);
const UTILITY_IDS = new Set([
  "memory-core", "memory-lancedb", "phone-control", "talk-voice",
  "synthetic", "diffs", "llm-task", "open-prose", "thread-ownership",
]);

function categorize(p: PluginRaw): string {
  if (CHANNEL_IDS.has(p.id)) return "channel";
  if (SEARCH_IDS.has(p.id)) return "search";
  if (SPEECH_IDS.has(p.id)) return "speech";
  if (IMAGE_IDS.has(p.id)) return "image";
  if (RUNTIME_IDS.has(p.id)) return "runtime";
  if (UTILITY_IDS.has(p.id)) return "utility";

  // Check capability arrays as fallback
  if (p.channelIds.length > 0) return "channel";
  if (p.webSearchProviderIds.length > 0 || p.webFetchProviderIds.length > 0) return "search";
  if (p.speechProviderIds.length > 0) return "speech";
  if (p.imageGenerationProviderIds.length > 0) return "image";
  if (p.mediaUnderstandingProviderIds.length > 0) return "media";
  if (p.providerIds.length > 0) return "provider";

  // Name-based fallback for providers
  if (p.name.includes("provider") || p.name.includes("Provider")) return "provider";

  return "other";
}

function getCapabilities(p: PluginRaw): string[] {
  const caps: string[] = [];
  const cat = categorize(p);

  // Add category-derived capabilities
  if (cat === "channel") caps.push(`channel:${p.id}`);
  if (cat === "search") caps.push("web-search");
  if (cat === "speech") caps.push("speech");
  if (cat === "image") caps.push("image-gen");
  if (cat === "provider") caps.push("model-provider");

  // Add from actual capability arrays
  if (p.channelIds.length > 0) caps.push(...p.channelIds.filter((c) => !caps.includes(`channel:${c}`)).map((c) => `channel:${c}`));
  if (p.webFetchProviderIds.length > 0) caps.push("web-fetch");
  if (p.mediaUnderstandingProviderIds.length > 0) caps.push("media");
  if (p.toolNames.length > 0) caps.push(`${p.toolNames.length} tools`);
  if (p.hookCount > 0) caps.push(`${p.hookCount} hooks`);
  if (p.httpRoutes > 0) caps.push(`${p.httpRoutes} routes`);
  if (p.services.length > 0) caps.push(`${p.services.length} services`);
  if (p.cliCommands.length > 0) caps.push(...p.cliCommands.map((c) => `cli:${c}`));
  if (p.configSchema) caps.push("configurable");
  return caps;
}

/** Run `openclaw plugins list --json` and cache the result briefly. */
let cache: { data: PluginSummary[]; ts: number } | null = null;
const CACHE_TTL_MS = 60_000; // 1 minute

function fetchPluginList(): Promise<PluginSummary[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return Promise.resolve(cache.data);
  }

  return new Promise((resolve, reject) => {
    const PATH = process.env.PATH ?? "";
    const homeBin = `${process.env.HOME}/.local/bin`;
    const envPath = PATH.includes(homeBin) ? PATH : `${homeBin}:${PATH}`;

    execFile("openclaw", ["plugins", "list", "--json"], {
      timeout: 15_000,
      env: { ...process.env, PATH: envPath },
    }, (err, stdout) => {
      if (err) {
        // If cached data exists, return stale rather than failing
        if (cache) return resolve(cache.data);
        return reject(new Error(`Failed to list plugins: ${err.message}`));
      }
      try {
        const raw: PluginListResponse = JSON.parse(stdout);
        const plugins: PluginSummary[] = raw.plugins.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          version: p.version,
          origin: p.origin,
          enabled: p.enabled,
          status: p.status,
          category: categorize(p),
          capabilities: getCapabilities(p),
        }));
        cache = { data: plugins, ts: Date.now() };
        resolve(plugins);
      } catch (parseErr) {
        if (cache) return resolve(cache.data);
        reject(new Error(`Failed to parse plugin list: ${parseErr}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /api/plugins — list all plugins with categories and capabilities */
pluginsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const plugins = await fetchPluginList();
    const enabled = plugins.filter((p) => p.enabled);
    const disabled = plugins.filter((p) => !p.enabled);

    ok(res, {
      total: plugins.length,
      enabled: enabled.length,
      disabled: disabled.length,
      plugins,
    });
  }),
);
