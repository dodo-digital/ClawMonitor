import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import {
  createTestPaths,
  removeTestPaths,
  seedBootstrapFiles,
  setTestEnv,
  type TestPaths,
} from "../test-helpers.js";

describe("bootstrap routes", () => {
  let paths: TestPaths;

  beforeEach(async () => {
    vi.resetModules();
    paths = createTestPaths("openclaw-bootstrap-");
    setTestEnv(paths);
    await seedBootstrapFiles(paths.workspaceDir, { "SOUL.md": "# SOUL\n\nInitial soul\n" });
  });

  afterEach(async () => {
    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await removeTestPaths(paths);
  });

  it("lists bootstrap files with budget metadata", async () => {
    const { createApp } = await import("../../index.js");
    const response = await request(createApp()).get("/api/bootstrap/files");

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.files).toHaveLength(8);
    expect(response.body.data.files[0]).toEqual(
      expect.objectContaining({
        name: expect.any(String),
        path: expect.any(String),
        sizeChars: expect.any(Number),
        budgetMax: expect.any(Number),
        injectionOrder: expect.any(Number),
        loadInSubagent: expect.any(Boolean),
        versionCount: expect.any(Number),
      }),
    );
    expect(Object.keys(response.body.data.files[0])).toContain("specialInstruction");
    expect(response.body.data.totalBudget).toMatchObject({
      used: expect.any(Number),
      max: 150000,
    });
  });

  it("reads an allowed bootstrap file", async () => {
    const { createApp } = await import("../../index.js");
    const response = await request(createApp()).get("/api/bootstrap/file/SOUL.md");

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      name: "SOUL.md",
      content: "# SOUL\n\nInitial soul\n",
    });
  });

  it("rejects a file outside the allowlist", async () => {
    const { createApp } = await import("../../index.js");
    const response = await request(createApp()).get("/api/bootstrap/file/EVIL.md");

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
  });

  it("rejects a traversal path", async () => {
    const { createApp } = await import("../../index.js");
    const response = await request(createApp()).get("/api/bootstrap/file/..%2F..%2F..%2Fetc%2Fpasswd");

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
  });

  it("writes an allowed file without creating a .bak file", async () => {
    const { createApp } = await import("../../index.js");
    const response = await request(createApp())
      .put("/api/bootstrap/file/SOUL.md")
      .send({ content: "# SOUL\n\nUpdated\n" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      name: "SOUL.md",
      sizeChars: "# SOUL\n\nUpdated\n".length,
    });

    const updatedPath = path.join(paths.workspaceDir, "SOUL.md");
    const backups = (await fs.promises.readdir(paths.workspaceDir)).filter((name) => name.startsWith("SOUL.md.bak."));

    expect(await fs.promises.readFile(updatedPath, "utf8")).toBe("# SOUL\n\nUpdated\n");
    expect(backups).toHaveLength(0);
  });

  it("rate limits repeated writes to the same file", async () => {
    const { createApp } = await import("../../index.js");
    const app = createApp();

    const first = await request(app)
      .put("/api/bootstrap/file/SOUL.md")
      .send({ content: "# SOUL\n\nFirst\n" });
    const second = await request(app)
      .put("/api/bootstrap/file/SOUL.md")
      .send({ content: "# SOUL\n\nSecond\n" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body).toEqual({
      ok: false,
      error: "Write rate limit exceeded for this file",
    });
  });

  it("rejects oversized writes", async () => {
    const { createApp } = await import("../../index.js");
    const response = await request(createApp())
      .put("/api/bootstrap/file/SOUL.md")
      .send({ content: "x".repeat(25001) });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
  });

  it("rejects writes to a disallowed file", async () => {
    const { createApp } = await import("../../index.js");
    const response = await request(createApp())
      .put("/api/bootstrap/file/EVIL.md")
      .send({ content: "nope" });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
  });
});
