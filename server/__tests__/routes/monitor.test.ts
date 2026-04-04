import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import {
  createTestPaths,
  removeTestPaths,
  setTestEnv,
  type TestPaths,
} from "../test-helpers.js";

describe("monitor routes", () => {
  let paths: TestPaths;

  beforeEach(() => {
    vi.resetModules();
    paths = createTestPaths("openclaw-monitor-routes-");
    setTestEnv(paths);
  });

  afterEach(async () => {
    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await removeTestPaths(paths);
  });

  it("lists incidents and returns incident detail", async () => {
    const { createApp } = await import("../../index.js");
    const { IncidentProcessor } = await import("../../monitor/incidents/processor.js");

    const processor = new IncidentProcessor(async () => {});
    await processor.processCheck({
      workspaceId: "default",
      checkType: "cron.job_status",
      targetKey: "nightly-rebuild",
      status: "failing",
      severity: "critical",
      summary: "Nightly rebuild last run failed",
      evidence: { status: "error" },
      observedAt: "2026-04-02T00:00:00.000Z",
      dedupeKey: "default:cron.job_status:nightly-rebuild:error",
      title: "Nightly rebuild is failing",
    });

    const app = createApp();

    const list = await request(app).get("/api/monitor/incidents");
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0]).toMatchObject({
      title: "Nightly rebuild is failing",
      status: "open",
      severity: "critical",
    });

    const detail = await request(app).get(`/api/monitor/incidents/${list.body.data.items[0].id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.incident).toMatchObject({
      title: "Nightly rebuild is failing",
      target_key: "nightly-rebuild",
    });
    expect(detail.body.data.events[0]).toMatchObject({
      event_type: "opened",
    });
    expect(detail.body.data.recentResults[0]).toMatchObject({
      check_type: "cron.job_status",
      status: "failing",
    });
  });
});
