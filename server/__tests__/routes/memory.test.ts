import path from "node:path";
import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import {
  createTestPaths,
  removeTestPaths,
  setTestEnv,
  writeTextFile,
  type TestPaths,
} from "../test-helpers.js";

describe("memory routes", () => {
  let paths: TestPaths;

  beforeEach(async () => {
    vi.resetModules();
    paths = createTestPaths("openclaw-memory-");
    setTestEnv(paths);

    await writeTextFile(path.join(paths.workspaceDir, "memory", "old.md"), "old");
    await writeTextFile(path.join(paths.workspaceDir, "memory", "new.md"), "new");
    await fs.promises.utimes(path.join(paths.workspaceDir, "memory", "old.md"), new Date("2026-04-01T00:00:00.000Z"), new Date("2026-04-01T00:00:00.000Z"));
    await fs.promises.utimes(path.join(paths.workspaceDir, "memory", "new.md"), new Date("2026-04-02T00:00:00.000Z"), new Date("2026-04-02T00:00:00.000Z"));
    await writeTextFile(path.join(paths.workspaceDir, "life", "README.md"), "life root");
    await writeTextFile(path.join(paths.workspaceDir, "life", "areas", "project.md"), "nested");
  });

  afterEach(async () => {
    vi.doUnmock("../../lib/system-info.js");
    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await removeTestPaths(paths);
  });

  it("returns qmd status, memory files, and life tree data", async () => {
    vi.doMock("../../lib/system-info.js", () => ({
      getQmdStatusOutput: vi.fn(async () => [
        "Collections:",
        "  life (qmd://life)",
        "    Pattern: life/**/*.md",
        "    Files: 2 (updated recently)",
        "Pending: 1 need embedding",
        "Size: 123 KB",
        "Total: 2 files indexed",
        "Vectors: 2 embedded",
      ].join("\n")),
      runQmdSearch: vi.fn(async () => "[]"),
      startQmdUpdate: vi.fn(async () => undefined),
    }));

    const { createApp } = await import("../../index.js");
    const app = createApp();

    const qmdStatus = await request(app).get("/api/memory/qmd/status");
    expect(qmdStatus.status).toBe(200);
    expect(qmdStatus.body.data).toMatchObject({
      pendingEmbeddings: 1,
      indexSize: "123 KB",
    });

    const files = await request(app).get("/api/memory/files");
    expect(files.status).toBe(200);
    expect(files.body.data).toHaveLength(2);
    expect(files.body.data.map((item: { name: string }) => item.name)).toEqual(["new.md", "old.md"]);

    const life = await request(app).get("/api/memory/life");
    expect(life.status).toBe(200);
    expect(life.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "README.md", type: "file" }),
        expect.objectContaining({ name: "areas", type: "directory" }),
      ]),
    );

    const search = await request(app)
      .post("/api/memory/qmd/search")
      .send({ query: "hello", collection: "life" });
    expect(search.status).toBe(200);
    expect(search.body).toEqual({
      ok: true,
      data: [],
    });

    const update = await request(app).post("/api/memory/qmd/update");
    expect(update.status).toBe(200);
    expect(update.body).toEqual({
      ok: true,
      data: { status: "started" },
    });
  });

  it("rejects invalid qmd search payloads", async () => {
    vi.doMock("../../lib/system-info.js", () => ({
      getQmdStatusOutput: vi.fn(async () => ""),
      runQmdSearch: vi.fn(async () => "[]"),
      startQmdUpdate: vi.fn(async () => undefined),
    }));

    const { createApp } = await import("../../index.js");
    const response = await request(createApp()).post("/api/memory/qmd/search").send({ query: "", collection: "" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: "query and collection are required",
    });
  });

  it("surfaces qmd command failures and invalid output", async () => {
    vi.doMock("../../lib/system-info.js", () => ({
      getQmdStatusOutput: vi.fn(async () => ""),
      startQmdUpdate: vi.fn(async () => undefined),
      runQmdSearch: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("spawn qmd ENOENT"), { code: "ENOENT" }))
        .mockRejectedValueOnce(Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }))
        .mockResolvedValueOnce("{not-json"),
    }));

    const { createApp } = await import("../../index.js");
    const app = createApp();

    const unavailable = await request(app)
      .post("/api/memory/qmd/search")
      .send({ query: "hello", collection: "life" });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error).toBe("qmd is not installed");

    const timeout = await request(app)
      .post("/api/memory/qmd/search")
      .send({ query: "hello", collection: "life" });
    expect(timeout.status).toBe(504);
    expect(timeout.body.error).toBe("qmd search timed out");

    const invalidJson = await request(app)
      .post("/api/memory/qmd/search")
      .send({ query: "hello", collection: "life" });
    expect(invalidJson.status).toBe(502);
    expect(invalidJson.body.error).toBe("qmd returned invalid JSON");
  });
});
