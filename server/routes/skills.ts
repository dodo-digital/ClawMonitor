import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { Router } from "express";

import { db } from "../lib/db.js";
import { env } from "../lib/env.js";
import { asyncHandler, ok } from "../lib/http.js";

export const skillsRouter = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SkillMeta = {
  name: string;
  description: string;
  version: string | null;
  source: "openclaw-managed" | "openclaw-workspace" | "openclaw-extra" | "openclaw-bundled";
  filePath: string;
  baseDir: string;
  installedVersion: string | null;
  installedAt: number | null;
};

/** Parse YAML front-matter from a SKILL.md file (between --- delimiters). */
function parseFrontMatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Skip multi-line values (like description: |)
    if (value === "|" || value === ">") continue;
    if (key && value) result[key] = value;
  }
  return result;
}

/** Scan a skill directory and collect metadata for each skill. */
async function scanSkillDir(
  dir: string,
  source: SkillMeta["source"],
): Promise<SkillMeta[]> {
  if (!fs.existsSync(dir)) return [];

  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const skills: SkillMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const baseDir = path.join(dir, entry.name);
    const skillFile = path.join(baseDir, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;

    try {
      const content = await fs.promises.readFile(skillFile, "utf8");
      const fm = parseFrontMatter(content);

      // Check for clawhub origin metadata
      let installedVersion: string | null = null;
      let installedAt: number | null = null;
      const originPath = path.join(baseDir, ".clawhub", "origin.json");
      if (fs.existsSync(originPath)) {
        try {
          const origin = JSON.parse(await fs.promises.readFile(originPath, "utf8"));
          installedVersion = origin.installedVersion ?? null;
          installedAt = origin.installedAt ?? null;
        } catch {
          // ignore bad origin files
        }
      }

      // Extract first sentence of description for skills with multi-line descriptions
      let description = fm.description ?? "";
      if (!description && content) {
        // Fall back: grab first non-heading, non-empty line after front-matter
        const body = content.replace(/^---[\s\S]*?---\s*/, "");
        const firstLine = body.split("\n").find((l) => l.trim() && !l.startsWith("#"));
        description = firstLine?.trim() ?? "";
      }

      skills.push({
        name: fm.name ?? entry.name,
        description,
        version: fm.version ?? installedVersion,
        source,
        filePath: skillFile,
        baseDir,
        installedVersion,
        installedAt,
      });
    } catch {
      // skip unreadable skills
    }
  }

  return skills;
}

// Simple cache to avoid rescanning filesystem on every request
let cachedSkills: SkillMeta[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000;

async function getAllSkills(): Promise<SkillMeta[]> {
  if (cachedSkills && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedSkills;
  }

  const [managed, workspace] = await Promise.all([
    scanSkillDir(path.join(env.openclawHome, "skills"), "openclaw-managed"),
    scanSkillDir(path.join(env.openclawHome, "workspace", "skills"), "openclaw-workspace"),
  ]);

  cachedSkills = [...managed, ...workspace];
  cacheTime = Date.now();
  return cachedSkills;
}

// ---------------------------------------------------------------------------
// GET /api/skills/list — All skills with metadata + usage stats
// ---------------------------------------------------------------------------

skillsRouter.get(
  "/list",
  asyncHandler(async (_req, res) => {
    const days = Math.min(Math.max(Number((_req.query.days as string) ?? 30), 1), 90);
    const skills = await getAllSkills();

    // Get usage stats from skill_triggers table
    const usageRows = db
      .prepare(
        `SELECT skill_name,
                COUNT(*) as trigger_count,
                COUNT(DISTINCT session_key) as unique_sessions,
                COUNT(DISTINCT channel) as unique_channels,
                MAX(timestamp) as last_triggered,
                GROUP_CONCAT(DISTINCT channel) as channels
         FROM skill_triggers
         WHERE timestamp > datetime('now', '-' || @days || ' days')
         GROUP BY skill_name`,
      )
      .all({ days }) as Array<{
      skill_name: string;
      trigger_count: number;
      unique_sessions: number;
      unique_channels: number;
      last_triggered: string;
      channels: string;
    }>;

    const usageMap = new Map(usageRows.map((row) => [row.skill_name, row]));

    const items = skills.map((skill) => {
      const usage = usageMap.get(skill.name);
      return {
        name: skill.name,
        description: skill.description,
        version: skill.version,
        source: skill.source,
        filePath: skill.filePath,
        triggerCount: usage?.trigger_count ?? 0,
        lastTriggered: usage?.last_triggered ?? null,
        uniqueSessions: usage?.unique_sessions ?? 0,
        uniqueChannels: usage?.unique_channels ?? 0,
        channels: usage?.channels?.split(",").filter(Boolean) ?? [],
      };
    });

    // Sort: most triggered first, then alphabetical
    items.sort((a, b) => b.triggerCount - a.triggerCount || a.name.localeCompare(b.name));

    ok(res, { skills: items, days });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/skills/:name/content — Return the SKILL.md body for a skill
// ---------------------------------------------------------------------------

skillsRouter.get(
  "/:name/content",
  asyncHandler(async (req, res) => {
    const { name } = req.params;
    const skills = await getAllSkills();
    const skill = skills.find((s) => s.name === name);

    if (!skill) {
      res.status(404).json({ ok: false, error: "Skill not found" });
      return;
    }

    const raw = await fs.promises.readFile(skill.filePath, "utf8");
    // Strip front-matter, return the markdown body
    const body = raw.replace(/^---[\s\S]*?---\s*/, "").trim();

    ok(res, { name: skill.name, content: body, filePath: skill.filePath });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/skills/:name/triggers — Trigger history for a specific skill
// ---------------------------------------------------------------------------

skillsRouter.get(
  "/:name/triggers",
  asyncHandler(async (req, res) => {
    const { name } = req.params;
    const days = Math.min(Math.max(Number(req.query.days ?? 30), 1), 90);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);

    const triggers = db
      .prepare(
        `SELECT id, skill_name, agent_id, session_key, channel, channel_name, source, timestamp
         FROM skill_triggers
         WHERE skill_name = @name AND timestamp > datetime('now', '-' || @days || ' days')
         ORDER BY timestamp DESC
         LIMIT @limit`,
      )
      .all({ name, days, limit }) as Array<{
      id: number;
      skill_name: string;
      agent_id: string;
      session_key: string;
      channel: string;
      channel_name: string | null;
      source: string;
      timestamp: string;
    }>;

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) as count FROM skill_triggers
           WHERE skill_name = @name AND timestamp > datetime('now', '-' || @days || ' days')`,
        )
        .get({ name, days }) as { count: number }
    ).count;

    ok(res, { triggers, total, days });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/skills/usage — Legacy: scan JSONL files for 7-day usage
// ---------------------------------------------------------------------------

skillsRouter.get(
  "/usage",
  asyncHandler(async (_req, res) => {
    const agentsDir = path.join(env.openclawHome, "agents");
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const usage = new Map<string, { triggerCount: number; lastUsed: string | null; channels: Set<string> }>();

    const agentDirs = await fs.promises.readdir(agentsDir, { withFileTypes: true });
    for (const entry of agentDirs) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) {
        continue;
      }

      const sessionDir = path.join(agentsDir, entry.name, "sessions");
      if (!fs.existsSync(sessionDir)) {
        continue;
      }

      const files = (await fs.promises.readdir(sessionDir)).filter((name) => name.endsWith(".jsonl"));
      for (const file of files) {
        const fullPath = path.join(sessionDir, file);
        const stats = await fs.promises.stat(fullPath);
        if (stats.mtimeMs < since) {
          continue;
        }

        const lineReader = readline.createInterface({
          input: fs.createReadStream(fullPath, { encoding: "utf8" }),
          crlfDelay: Infinity,
        });

        for await (const line of lineReader) {
          if (!line.includes("SKILL.md")) {
            continue;
          }

          const match = line.match(/skills\/([^/]+)\/SKILL\.md/);
          if (!match) {
            continue;
          }
          const skillName = match[1];
          const parsed = JSON.parse(line) as { timestamp?: string };
          const current = usage.get(skillName) ?? { triggerCount: 0, lastUsed: null, channels: new Set<string>() };
          current.triggerCount += 1;
          current.lastUsed = parsed.timestamp ?? current.lastUsed;
          current.channels.add(entry.name);
          usage.set(skillName, current);
        }
      }
    }

    ok(
      res,
      Array.from(usage.entries()).map(([skill, data]) => ({
        skill,
        triggerCount: data.triggerCount,
        lastUsed: data.lastUsed,
        channels: Array.from(data.channels.values()).sort(),
      })),
    );
  }),
);
