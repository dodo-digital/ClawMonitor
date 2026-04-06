import fs from "node:fs";
import path from "node:path";

import { Router } from "express";

import { TTLCache } from "../lib/cache.js";
import { PROJECT_ROOT } from "../lib/constants.js";
import { env } from "../lib/env.js";
import { HttpError } from "../lib/errors.js";
import { ensureInsideBase } from "../lib/filesystem.js";
import { asyncHandler, ok } from "../lib/http.js";
import { getExtraPaths, getAgentWorkspace, getAgentExtraPaths } from "../lib/openclaw.js";
import { getQmdStatusOutput, runQmdSearch, startQmdUpdate } from "../lib/system-info.js";

const cache = new TTLCache<string, unknown>();

function parseQmdStatus(raw: string): Record<string, unknown> {
  const lines = raw.split("\n");
  const collections: Array<Record<string, unknown>> = [];
  let currentCollection: Record<string, unknown> | null = null;

  for (const line of lines) {
    const collectionHeaderMatch = line.match(/^\s{2}([^(]+)\s+\(qmd:\/\/[^)]+\)/);
    if (collectionHeaderMatch) {
      currentCollection = {
        name: collectionHeaderMatch[1].trim(),
      };
      collections.push(currentCollection);
      continue;
    }

    const patternMatch = line.match(/^\s{4}Pattern:\s+(.+)$/);
    if (patternMatch && currentCollection) {
      currentCollection.pattern = patternMatch[1].trim();
      continue;
    }

    const filesMatch = line.match(/^\s{4}Files:\s+(\d+)\s+\(updated\s+(.+)\)$/);
    if (filesMatch && currentCollection) {
      currentCollection.fileCount = Number(filesMatch[1]);
      currentCollection.updated = filesMatch[2].trim();
      continue;
    }

    const collectionMatch = line.match(/^\s*-\s+([^\:]+):\s+(\d+)\s+files?/i);
    if (collectionMatch) {
      collections.push({
        name: collectionMatch[1].trim(),
        fileCount: Number(collectionMatch[2]),
      });
    }
  }

  const pendingMatch = raw.match(/Pending:\s+(\d+)\s+need embedding/i);
  const indexSizeMatch = raw.match(/Size:\s+([^\n]+)/i);
  const totalFilesMatch = raw.match(/Total:\s+(\d+)\s+files indexed/i);
  const vectorsMatch = raw.match(/Vectors:\s+(\d+)\s+embedded/i);

  return {
    raw,
    collections,
    pendingEmbeddings: pendingMatch ? Number(pendingMatch[1]) : null,
    indexSize: indexSizeMatch?.[1]?.trim() ?? null,
    totalFiles: totalFilesMatch ? Number(totalFilesMatch[1]) : null,
    embeddedVectors: vectorsMatch ? Number(vectorsMatch[1]) : null,
  };
}

function buildTree(rootPath: string): Array<Record<string, unknown>> {
  const entries = fs.readdirSync(rootPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  return entries.map((entry) => {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      return {
        name: entry.name,
        type: "directory",
        children: buildTree(fullPath),
      };
    }
    const stats = fs.statSync(fullPath);
    return {
      name: entry.name,
      type: "file",
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  });
}

export const memoryRouter = Router();

memoryRouter.get(
  "/qmd/status",
  asyncHandler(async (_req, res) => {
    const data = await cache.getOrSet("memory:qmd-status", async () => parseQmdStatus(await getQmdStatusOutput()), 60_000);
    ok(res, data);
  }),
);

memoryRouter.post(
  "/qmd/search",
  asyncHandler(async (req, res) => {
    const query = String(req.body?.query ?? "").trim();
    const collection = String(req.body?.collection ?? "").trim();
    if (!query || !collection) {
      throw new HttpError("query and collection are required", 400);
    }

    try {
      ok(res, JSON.parse(await runQmdSearch(query, collection)));
    } catch (error) {
      const commandError = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null };
      if (commandError.code === "ENOENT") {
        throw new HttpError("qmd is not installed", 503);
      }
      if (commandError.killed || commandError.signal === "SIGTERM") {
        throw new HttpError("qmd search timed out", 504);
      }
      if (error instanceof SyntaxError) {
        throw new HttpError("qmd returned invalid JSON", 502);
      }
      throw error;
    }
  }),
);

memoryRouter.post(
  "/qmd/update",
  asyncHandler(async (_req, res) => {
    await startQmdUpdate();
    ok(res, { status: "started" });
  }),
);

memoryRouter.get(
  "/files",
  asyncHandler(async (_req, res) => {
    const memoryDir = path.join(env.workspaceDir, "memory");
    const entries = (await fs.promises.readdir(memoryDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"));

    const items = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(memoryDir, entry.name);
        const stats = await fs.promises.stat(fullPath);
        // Read first 500 chars for preview
        let preview = "";
        try {
          const content = await fs.promises.readFile(fullPath, "utf8");
          // Skip the "# YYYY-MM-DD" header line, grab first meaningful content
          const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("# "));
          preview = lines.slice(0, 3).join(" ").slice(0, 200).trim();
        } catch {
          // skip
        }
        return {
          name: entry.name,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          preview,
        };
      }),
    );

    items.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
    ok(res, items);
  }),
);

memoryRouter.get(
  "/file/:name",
  asyncHandler(async (req, res) => {
    const name = String(req.params.name);
    const safePath = ensureInsideBase(name, path.join(env.workspaceDir, "memory"));
    ok(res, {
      name,
      content: await fs.promises.readFile(safePath, "utf8"),
    });
  }),
);

memoryRouter.get(
  "/life",
  asyncHandler(async (_req, res) => {
    ok(res, buildTree(path.join(env.workspaceDir, "life")));
  }),
);

// --- Activity feed: recent fact changes across all items.json files ---

type Fact = {
  id: string;
  fact: string;
  category: string;
  timestamp: string;
  source: string;
  status: string;
  supersededBy: string | null;
  lastAccessed: string;
  accessCount: number;
  priority: string;
};

type EntityFile = {
  id: string;
  entity: string;
  facts: Fact[];
};

async function collectItemsJsonFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectItemsJsonFiles(full)));
    } else if (entry.name === "items.json") {
      results.push(full);
    }
  }
  return results;
}

memoryRouter.get(
  "/activity",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const lifeDir = path.join(env.workspaceDir, "life");

    const itemFiles = await collectItemsJsonFiles(lifeDir);

    type ActivityItem = {
      factId: string;
      fact: string;
      category: string;
      timestamp: string;
      source: string;
      status: string;
      priority: string;
      entity: string;
      entityPath: string;
    };

    const allFacts: ActivityItem[] = [];

    for (const filePath of itemFiles) {
      try {
        const raw = await fs.promises.readFile(filePath, "utf8");
        const data: EntityFile = JSON.parse(raw);
        const entityPath = path.relative(lifeDir, path.dirname(filePath));

        for (const fact of data.facts) {
          allFacts.push({
            factId: fact.id,
            fact: fact.fact,
            category: fact.category,
            timestamp: fact.timestamp,
            source: fact.source,
            status: fact.status,
            priority: fact.priority,
            entity: data.entity,
            entityPath,
          });
        }
      } catch {
        // skip malformed files
      }
    }

    // Sort by timestamp descending, then by fact ID descending for tie-breaking
    allFacts.sort((a, b) => {
      const tsA = a.timestamp ?? "";
      const tsB = b.timestamp ?? "";
      const cmp = tsB.localeCompare(tsA);
      if (cmp !== 0) return cmp;
      return (b.factId ?? "").localeCompare(a.factId ?? "");
    });

    // Also gather recent memory markdown files
    const memoryDir = path.join(env.workspaceDir, "memory");
    type MemoryNote = {
      name: string;
      modifiedAt: string;
      size: number;
    };

    let recentNotes: MemoryNote[] = [];
    try {
      const entries = await fs.promises.readdir(memoryDir, { withFileTypes: true });
      recentNotes = entries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => {
          const stats = fs.statSync(path.join(memoryDir, e.name));
          return { name: e.name, modifiedAt: stats.mtime.toISOString(), size: stats.size };
        })
        .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
        .slice(0, 10);
    } catch {
      // no memory dir
    }

    ok(res, {
      facts: allFacts.slice(0, limit),
      totalFacts: allFacts.length,
      recentNotes,
    });
  }),
);

// --- Entity detail: load a single entity's items.json with computed metadata ---

memoryRouter.get(
  "/entity",
  asyncHandler(async (req, res) => {
    const entityPath = String(req.query.path ?? "").trim();
    if (!entityPath) {
      throw new HttpError("path query parameter is required", 400);
    }
    const safePath = ensureInsideBase(path.join(entityPath, "items.json"), path.join(env.workspaceDir, "life"));
    const raw = await fs.promises.readFile(safePath, "utf8");
    const data: EntityFile = JSON.parse(raw);

    const now = Date.now();
    const factsWithDecay = data.facts.map((f) => {
      const lastAccessed = new Date(f.lastAccessed).getTime();
      const daysSinceAccess = Math.floor((now - lastAccessed) / (1000 * 60 * 60 * 24));
      const decay: "hot" | "warm" | "cold" =
        daysSinceAccess <= 7 ? "hot" : daysSinceAccess <= 30 ? "warm" : "cold";
      return { ...f, daysSinceAccess, decay };
    });

    ok(res, {
      id: data.id,
      entity: data.entity,
      facts: factsWithDecay,
      totalFacts: data.facts.length,
      activeFacts: data.facts.filter((f) => f.status === "active").length,
      supersededFacts: data.facts.filter((f) => f.status === "superseded").length,
    });
  }),
);

// --- Data sources: read from data-sources.json config ---

type DataSourceConfig = {
  id: string;
  name: string;
  description?: string;
  type: string;
  path: string;
  native: boolean;
  renderer: string;
  glob?: string;
};

type DataSourcesFile = {
  version: number;
  sources: DataSourceConfig[];
};

async function countFilesMatching(baseDir: string, pattern: string): Promise<number> {
  if (pattern === "*.md") {
    try {
      const entries = await fs.promises.readdir(baseDir);
      return entries.filter((e) => e.endsWith(".md")).length;
    } catch {
      return 0;
    }
  }
  if (pattern === "**/items.json") {
    try {
      return (await collectItemsJsonFiles(baseDir)).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

memoryRouter.get(
  "/sources",
  asyncHandler(async (_req, res) => {
    // Check workspace first (user's custom config), fall back to repo default
    const workspacePath = path.join(env.workspaceDir, "data-sources.json");
    const defaultPath = path.join(PROJECT_ROOT, "data-sources.default.json");

    let config: DataSourcesFile;
    try {
      const raw = await fs.promises.readFile(workspacePath, "utf8");
      config = JSON.parse(raw);
    } catch {
      try {
        const raw = await fs.promises.readFile(defaultPath, "utf8");
        config = JSON.parse(raw);
      } catch {
        ok(res, []);
        return;
      }
    }

    const results = await Promise.all(
      config.sources.map(async (source) => {
        const resolvedPath = path.join(env.workspaceDir, source.path);
        const entityCount = await countFilesMatching(resolvedPath, source.glob ?? "");
        return {
          id: source.id,
          name: source.name,
          description: source.description ?? "",
          type: source.type,
          path: source.path,
          native: source.native,
          renderer: source.renderer,
          entityCount,
        };
      }),
    );

    ok(res, results);
  }),
);

memoryRouter.get(
  /^\/life\/(.+)$/,
  asyncHandler(async (req, res) => {
    const relativePath = req.params[0];
    const safePath = ensureInsideBase(relativePath, path.join(env.workspaceDir, "life"));
    const stats = await fs.promises.stat(safePath);
    if (!stats.isFile()) {
      throw new HttpError("Target is not a file", 400);
    }
    ok(res, {
      path: relativePath,
      content: await fs.promises.readFile(safePath, "utf8"),
    });
  }),
);

// --- Agent Context: extraPaths visibility ---

function categorizeExtraPath(filePath: string): string {
  const name = path.basename(filePath).toLowerCase();
  if (["soul.md", "identity.md", "user.md"].includes(name)) return "identity";
  if (["priority-map.md", "auto-resolver.md", "heartbeat.md"].includes(name)) return "policy";
  if (["tools.md", "tools-gog.md", "accounts.md", "security.md", "agents.md"].includes(name)) return "reference";
  if (name === "contacts.md") return "contacts";
  if (filePath.includes("tasks/")) return "tasks";
  if (name === "skill.md" || filePath.includes("/skills/")) return "skill";
  // Check if it's a directory path (life/, knowledge/, research/, projects/)
  const dirName = path.basename(filePath);
  if (["life", "knowledge", "research", "projects"].includes(dirName)) return "knowledge-dir";
  return "other";
}

async function getFilePreview(filePath: string): Promise<string> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("---"));
    return lines.slice(0, 4).join(" ").slice(0, 200).trim();
  } catch {
    return "";
  }
}

memoryRouter.get(
  "/agent-context",
  asyncHandler(async (req, res) => {
    const agentId = req.query.agent ? String(req.query.agent) : null;
    const cacheKey = agentId ? `memory:agent-context:${agentId}` : "memory:agent-context";
    const data = await cache.getOrSet(cacheKey, async () => {
      const extraPaths = agentId ? await getAgentExtraPaths(agentId) : await getExtraPaths();
      const workspaceDir = agentId ? await getAgentWorkspace(agentId) : env.workspaceDir;

      // Resolve registered paths
      const registered = await Promise.all(
        extraPaths.map(async (p) => {
          let exists = false;
          let isDirectory = false;
          let size: number | undefined;
          let modifiedAt: string | undefined;
          let preview = "";

          try {
            const stats = await fs.promises.stat(p);
            exists = true;
            isDirectory = stats.isDirectory();
            if (!isDirectory) {
              size = stats.size;
              modifiedAt = stats.mtime.toISOString();
              if (p.endsWith(".md")) {
                preview = await getFilePreview(p);
              }
            } else {
              modifiedAt = stats.mtime.toISOString();
            }
          } catch {
            // File doesn't exist
          }

          const relativePath = p.startsWith(workspaceDir)
            ? p.slice(workspaceDir.length + 1)
            : p.startsWith(env.openclawHome)
              ? "~/.openclaw/" + p.slice(env.openclawHome.length + 1)
              : p;

          return {
            path: p,
            relativePath,
            category: categorizeExtraPath(p),
            exists,
            isDirectory,
            size,
            modifiedAt,
            preview,
          };
        }),
      );

      // Collect all registered paths and registered directory prefixes
      const registeredSet = new Set(extraPaths);
      const registeredDirs = extraPaths.filter((p) => {
        try { return fs.statSync(p).isDirectory(); } catch { return false; }
      });

      // Scan workspace for orphans (*.md files not in extraPaths and not inside a registered dir)
      const orphans: Array<{
        path: string;
        relativePath: string;
        size: number;
        modifiedAt: string;
      }> = [];

      try {
        const entries = await fs.promises.readdir(workspaceDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const fullPath = path.join(workspaceDir, entry.name);
          if (registeredSet.has(fullPath)) continue;
          // Check if inside a registered directory
          const insideRegistered = registeredDirs.some((dir) => fullPath.startsWith(dir + "/"));
          if (insideRegistered) continue;

          const stats = await fs.promises.stat(fullPath);
          orphans.push({
            path: fullPath,
            relativePath: entry.name,
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
          });
        }
      } catch {
        // workspace dir unreadable
      }

      const totalExisting = registered.filter((r) => r.exists).length;
      const totalMissing = registered.filter((r) => !r.exists).length;
      const totalDirectories = registered.filter((r) => r.isDirectory).length;

      return {
        registered,
        orphans,
        stats: {
          totalRegistered: registered.length,
          totalExisting,
          totalMissing,
          totalOrphans: orphans.length,
          totalDirectories,
        },
      };
    }, 30_000);

    ok(res, data);
  }),
);

memoryRouter.get(
  "/agent-context/file",
  asyncHandler(async (req, res) => {
    const filePath = String(req.query.path ?? "").trim();
    if (!filePath) {
      throw new HttpError("path query parameter is required", 400);
    }

    // Must be inside workspace or openclaw home
    const isInWorkspace = filePath.startsWith(env.workspaceDir);
    const isInOpenClaw = filePath.startsWith(env.openclawHome);
    if (!isInWorkspace && !isInOpenClaw) {
      throw new HttpError("Path must be inside workspace or OpenClaw home", 403);
    }

    try {
      const stats = await fs.promises.stat(filePath);
      if (!stats.isFile()) {
        throw new HttpError("Target is not a file", 400);
      }
      const content = await fs.promises.readFile(filePath, "utf8");
      ok(res, {
        path: filePath,
        name: path.basename(filePath),
        content,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HttpError("File not found", 404);
      }
      throw err;
    }
  }),
);

memoryRouter.put(
  "/agent-context/file",
  asyncHandler(async (req, res) => {
    const filePath = String(req.query.path ?? "").trim();
    if (!filePath) {
      throw new HttpError("path query parameter is required", 400);
    }

    const content = String(req.body?.content ?? "");

    // Must be inside workspace or openclaw home
    const isInWorkspace = filePath.startsWith(env.workspaceDir);
    const isInOpenClaw = filePath.startsWith(env.openclawHome);
    if (!isInWorkspace && !isInOpenClaw) {
      throw new HttpError("Path must be inside workspace or OpenClaw home", 403);
    }

    // Ensure the file already exists (don't create new files via this endpoint)
    if (!fs.existsSync(filePath)) {
      throw new HttpError("File not found — cannot create new files via this endpoint", 404);
    }

    await fs.promises.writeFile(filePath, content, "utf8");

    ok(res, {
      path: filePath,
      name: path.basename(filePath),
      size: Buffer.byteLength(content, "utf8"),
    });
  }),
);
