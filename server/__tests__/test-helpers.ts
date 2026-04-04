import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BOOTSTRAP_FILES } from "../lib/constants.js";

export type TestPaths = {
  rootDir: string;
  openclawHome: string;
  workspaceDir: string;
};

export function createTestPaths(prefix = "openclaw-dashboard-"): TestPaths {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const openclawHome = path.join(rootDir, ".openclaw");
  const workspaceDir = path.join(openclawHome, "workspace");

  fs.mkdirSync(openclawHome, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(openclawHome, "agents"), { recursive: true });
  fs.mkdirSync(path.join(openclawHome, "cron"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "life"), { recursive: true });

  return { rootDir, openclawHome, workspaceDir };
}

export function setTestEnv(paths: TestPaths, overrides: Record<string, string> = {}): void {
  process.env.OPENCLAW_GATEWAY_URL = overrides.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";
  process.env.OPENCLAW_GATEWAY_WS = overrides.OPENCLAW_GATEWAY_WS ?? "ws://127.0.0.1:18789";
  process.env.OPENCLAW_GATEWAY_TOKEN = overrides.OPENCLAW_GATEWAY_TOKEN ?? "test-token";
  process.env.OPENCLAW_HOME = overrides.OPENCLAW_HOME ?? paths.openclawHome;
  process.env.OPENCLAW_WORKSPACE = overrides.OPENCLAW_WORKSPACE ?? paths.workspaceDir;
  process.env.PORT = overrides.PORT ?? "18801";
}

export async function removeTestPaths(paths: TestPaths): Promise<void> {
  await fs.promises.rm(paths.rootDir, { recursive: true, force: true });
}

export async function writeTextFile(targetPath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.writeFile(targetPath, content, "utf8");
}

export async function writeJsonFile(targetPath: string, data: unknown): Promise<void> {
  await writeTextFile(targetPath, `${JSON.stringify(data, null, 2)}\n`);
}

export async function seedBootstrapFiles(workspaceDir: string, overrides: Record<string, string> = {}): Promise<void> {
  for (const file of BOOTSTRAP_FILES) {
    await writeTextFile(
      path.join(workspaceDir, file.name),
      overrides[file.name] ?? `# ${file.name}\n\nFixture content for ${file.name}.\n`,
    );
  }
}

export async function seedOpenClawConfig(
  openclawHome: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await writeJsonFile(path.join(openclawHome, "openclaw.json"), {
    meta: {
      lastTouchedVersion: "v2026.4.1",
      lastTouchedAt: "2026-04-01T00:00:00.000Z",
    },
    acp: {
      enabled: true,
      providers: ["claude"],
    },
    bindings: [
      {
        agentId: "direct",
        match: {
          telegram: {
            chatId: "-1003691004254",
          },
        },
      },
    ],
    agents: {
      defaults: {
        model: "gpt-default",
        workspace: "/workspace/default",
        memorySearch: {
          sources: ["life", "memory"],
        },
      },
      list: [
        {
          id: "direct",
          workspace: "/workspace/direct",
          model: "gpt-direct",
          runtime: { type: "native" },
        },
        {
          id: "acp-claude",
          workspace: "/workspace/acp",
          runtime: { type: "acp" },
        },
      ],
    },
    ...overrides,
  });
}

export async function createSessionFixture(options: {
  openclawHome: string;
  agentId?: string;
  sessionId?: string;
  sessionKey: string;
  sessionFileName?: string;
  updatedAt?: number;
  lines: string[];
}): Promise<{ sessionFile: string; sessionsIndexPath: string; sessionId: string; agentId: string }> {
  const agentId = options.agentId ?? "direct";
  const sessionId = options.sessionId ?? "session-1";
  const sessionFileName = options.sessionFileName ?? `${sessionId}.jsonl`;
  const sessionsDir = path.join(options.openclawHome, "agents", agentId, "sessions");
  const sessionFile = path.join(sessionsDir, sessionFileName);
  const sessionsIndexPath = path.join(sessionsDir, "sessions.json");

  await fs.promises.mkdir(sessionsDir, { recursive: true });
  await writeTextFile(sessionFile, `${options.lines.join("\n")}\n`);
  const existingIndex = fs.existsSync(sessionsIndexPath)
    ? (JSON.parse(await fs.promises.readFile(sessionsIndexPath, "utf8")) as Record<string, unknown>)
    : {};
  await writeJsonFile(sessionsIndexPath, {
    ...existingIndex,
    [options.sessionKey]: {
      sessionId,
      sessionFile,
      updatedAt: options.updatedAt ?? Date.now(),
    },
  });

  return { sessionFile, sessionsIndexPath, sessionId, agentId };
}

export async function collectWebSocketMessage(socket: import("ws").WebSocket): Promise<string> {
  return await new Promise((resolve, reject) => {
    const onMessage = (data: import("ws").RawData) => {
      cleanup();
      resolve(data.toString());
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}
