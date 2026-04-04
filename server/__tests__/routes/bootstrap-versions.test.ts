import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { BOOTSTRAP_WRITE_WINDOW_MS } from "../../lib/constants.js";
import {
  createTestPaths,
  removeTestPaths,
  seedBootstrapFiles,
  setTestEnv,
  type TestPaths,
} from "../test-helpers.js";

describe("bootstrap version routes", () => {
  let paths: TestPaths;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T00:00:00.000Z"));

    paths = createTestPaths("openclaw-bootstrap-versions-");
    setTestEnv(paths);
    await seedBootstrapFiles(paths.workspaceDir, { "SOUL.md": "# SOUL\n\nInitial soul\n" });
  });

  afterEach(async () => {
    vi.useRealTimers();

    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await removeTestPaths(paths);
  });

  function advanceWriteWindow(): void {
    vi.advanceTimersByTime(BOOTSTRAP_WRITE_WINDOW_MS + 1);
  }

  it("saves a file and creates a version entry in the database", async () => {
    const { createApp } = await import("../../index.js");
    const app = createApp();

    const saveResponse = await request(app)
      .put("/api/bootstrap/file/SOUL.md")
      .send({ content: "# SOUL\n\nFirst version\n" });
    const versionsResponse = await request(app).get("/api/bootstrap/file/SOUL.md/versions");

    expect(saveResponse.status).toBe(200);
    expect(versionsResponse.status).toBe(200);
    expect(versionsResponse.body.data).toHaveLength(1);
    expect(versionsResponse.body.data[0]).toMatchObject({
      file_name: "SOUL.md",
      char_count: "# SOUL\n\nInitial soul\n".length,
      label: null,
    });
  });

  it("saves again and returns versions newest first with counts on the file list", async () => {
    const { createApp } = await import("../../index.js");
    const app = createApp();

    await request(app).put("/api/bootstrap/file/SOUL.md").send({ content: "# SOUL\n\nFirst version\n" });
    advanceWriteWindow();
    await request(app).put("/api/bootstrap/file/SOUL.md").send({ content: "# SOUL\n\nSecond version\n" });

    const versionsResponse = await request(app).get("/api/bootstrap/file/SOUL.md/versions");
    const filesResponse = await request(app).get("/api/bootstrap/files");

    expect(versionsResponse.status).toBe(200);
    expect(versionsResponse.body.data).toHaveLength(2);
    expect(versionsResponse.body.data.map((version: { id: number }) => version.id)).toEqual([2, 1]);
    expect(filesResponse.body.data.files.find((file: { name: string }) => file.name === "SOUL.md")).toMatchObject({
      name: "SOUL.md",
      versionCount: 2,
    });
  });

  it("returns specific version content", async () => {
    const { createApp } = await import("../../index.js");
    const app = createApp();

    await request(app).put("/api/bootstrap/file/SOUL.md").send({ content: "# SOUL\n\nFirst version\n" });
    advanceWriteWindow();
    await request(app).put("/api/bootstrap/file/SOUL.md").send({ content: "# SOUL\n\nSecond version\n" });

    const versionsResponse = await request(app).get("/api/bootstrap/file/SOUL.md/versions");
    const versionId = versionsResponse.body.data[0].id;
    const versionResponse = await request(app).get(`/api/bootstrap/file/SOUL.md/versions/${versionId}`);

    expect(versionResponse.status).toBe(200);
    expect(versionResponse.body.data).toMatchObject({
      id: versionId,
      file_name: "SOUL.md",
      content: "# SOUL\n\nFirst version\n",
      char_count: "# SOUL\n\nFirst version\n".length,
    });
  });

  it("returns a unified diff between two versions", async () => {
    const { createApp } = await import("../../index.js");
    const app = createApp();

    await request(app).put("/api/bootstrap/file/SOUL.md").send({ content: "# SOUL\n\nFirst version\n" });
    advanceWriteWindow();
    await request(app).put("/api/bootstrap/file/SOUL.md").send({ content: "# SOUL\n\nSecond version\n" });

    const versionsResponse = await request(app).get("/api/bootstrap/file/SOUL.md/versions");
    const [newer, older] = versionsResponse.body.data as Array<{ id: number }>;
    const diffResponse = await request(app).get(`/api/bootstrap/file/SOUL.md/diff?from=${older.id}&to=${newer.id}`);

    expect(diffResponse.status).toBe(200);
    expect(diffResponse.body.data.from.id).toBe(older.id);
    expect(diffResponse.body.data.to.id).toBe(newer.id);
    expect(diffResponse.body.data.diff).toContain("--- SOUL.md@1");
    expect(diffResponse.body.data.diff).toContain("+++ SOUL.md@2");
    expect(diffResponse.body.data.diff).toContain("-Initial soul");
    expect(diffResponse.body.data.diff).toContain("+First version");
  });

  it("restores a version, writes it to disk, and creates a new labeled version entry", async () => {
    const { createApp } = await import("../../index.js");
    const app = createApp();

    await request(app).put("/api/bootstrap/file/SOUL.md").send({ content: "# SOUL\n\nFirst version\n" });
    advanceWriteWindow();
    await request(app).put("/api/bootstrap/file/SOUL.md").send({ content: "# SOUL\n\nSecond version\n" });

    const versionsResponse = await request(app).get("/api/bootstrap/file/SOUL.md/versions");
    const initialVersionId = versionsResponse.body.data[1].id;
    advanceWriteWindow();
    const restoreResponse = await request(app).post(`/api/bootstrap/file/SOUL.md/restore/${initialVersionId}`);
    const updatedContent = await fs.promises.readFile(path.join(paths.workspaceDir, "SOUL.md"), "utf8");
    const updatedVersions = await request(app).get("/api/bootstrap/file/SOUL.md/versions");

    expect(restoreResponse.status).toBe(200);
    expect(restoreResponse.body.data).toMatchObject({
      name: "SOUL.md",
      content: "# SOUL\n\nInitial soul\n",
    });
    expect(updatedContent).toBe("# SOUL\n\nInitial soul\n");
    expect(updatedVersions.body.data).toHaveLength(3);
    expect(updatedVersions.body.data[0]).toMatchObject({
      label: `Restored from version #${initialVersionId}`,
      char_count: "# SOUL\n\nInitial soul\n".length,
    });
  });

  it("updates a version label", async () => {
    const { createApp } = await import("../../index.js");
    const app = createApp();

    await request(app).put("/api/bootstrap/file/SOUL.md").send({ content: "# SOUL\n\nFirst version\n" });
    const versionsResponse = await request(app).get("/api/bootstrap/file/SOUL.md/versions");
    const versionId = versionsResponse.body.data[0].id;

    const labelResponse = await request(app)
      .put(`/api/bootstrap/file/SOUL.md/versions/${versionId}/label`)
      .send({ label: "toned down personality" });
    const updatedVersionResponse = await request(app).get(`/api/bootstrap/file/SOUL.md/versions/${versionId}`);

    expect(labelResponse.status).toBe(200);
    expect(labelResponse.body.data).toMatchObject({
      id: versionId,
      file_name: "SOUL.md",
      label: "toned down personality",
    });
    expect(updatedVersionResponse.body.data.label).toBe("toned down personality");
  });
});
