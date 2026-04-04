import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestPaths, removeTestPaths, setTestEnv, type TestPaths } from "./test-helpers.js";

async function listen(server: import("node:http").Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not bind to a TCP port");
  }
  return address.port;
}

describe("backend smoke startup", () => {
  let paths: TestPaths;

  beforeEach(() => {
    vi.resetModules();
    paths = createTestPaths("openclaw-smoke-");
  });

  afterEach(async () => {
    try {
      const dbModule = await import("../lib/db.js");
      if (typeof dbModule.db !== "undefined") {
        dbModule.db.close();
      }
    } catch {
      // Ignore follow-up cleanup if the module failed to initialize.
    }
    await removeTestPaths(paths);
  });

  it("starts the server with a test env and serves /api/health", async () => {
    setTestEnv(paths);

    const { createHttpServer } = await import("../index.js");
    const { server } = createHttpServer({ attachLiveFeed: false });

    try {
      const port = await listen(server);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        data: { status: "ok" },
      });
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  });

  it("does not swallow database initialization failures", async () => {
    const invalidHome = path.join(paths.rootDir, "invalid-home");
    fs.writeFileSync(invalidHome, "not a directory\n");
    setTestEnv(paths, { OPENCLAW_HOME: invalidHome });

    await expect(import("../index.js")).rejects.toThrow();
  });
});
