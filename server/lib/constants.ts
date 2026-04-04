import path from "node:path";

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
export const DIST_DIR = path.join(PROJECT_ROOT, "dist");
export const DEFAULT_PORT = 18801;
export const DEFAULT_CACHE_TTL_MS = 30_000;
export const COMMAND_TIMEOUT_MS = 10_000;
export const BOOTSTRAP_BUDGET_MAX = 150_000;
export const BOOTSTRAP_FILE_BUDGET_MAX = 20_000;
export const BOOTSTRAP_WRITE_LIMIT = 25_000;
export const BOOTSTRAP_WRITE_WINDOW_MS = 5_000;

export const BOOTSTRAP_FILES = [
  {
    name: "AGENTS.md",
    injectionOrder: 1,
    loadInSubagent: true,
  },
  {
    name: "SOUL.md",
    injectionOrder: 2,
    loadInSubagent: true,
    specialInstruction: "System instruction: embody persona and tone",
  },
  {
    name: "TOOLS.md",
    injectionOrder: 3,
    loadInSubagent: true,
  },
  {
    name: "IDENTITY.md",
    injectionOrder: 4,
    loadInSubagent: true,
  },
  {
    name: "USER.md",
    injectionOrder: 5,
    loadInSubagent: true,
  },
  {
    name: "HEARTBEAT.md",
    injectionOrder: 6,
    loadInSubagent: false,
  },
  {
    name: "BOOTSTRAP.md",
    injectionOrder: 7,
    loadInSubagent: false,
  },
  {
    name: "MEMORY.md",
    injectionOrder: 8,
    loadInSubagent: false,
  },
] as const;

export const BOOTSTRAP_FILE_NAMES = new Set(BOOTSTRAP_FILES.map((file) => file.name));
