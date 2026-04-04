import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db, initializeDatabase } from "../../lib/db.js";
import { IncidentProcessor } from "../../monitor/incidents/processor.js";
import { getIncidentDetail, listIncidents } from "../../monitor/incidents/store.js";
import type { MonitorCheckResultInput } from "../../monitor/types.js";

describe("incident processor", () => {
  let rootDir: string;
  let dbPath: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-monitor-incidents-"));
    dbPath = path.join(rootDir, "dashboard.sqlite");
    initializeDatabase(dbPath);
  });

  afterEach(async () => {
    db.close();
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  it("deduplicates repeated failures and resolves on recovery", async () => {
    const notify = vi.fn(async () => {});
    const processor = new IncidentProcessor(notify);

    const failingCheck: MonitorCheckResultInput = {
      workspaceId: "default",
      checkType: "system.disk",
      targetKey: "/",
      status: "failing",
      severity: "critical",
      summary: "Disk usage is at 98%",
      evidence: { usePercent: 98 },
      observedAt: "2026-04-02T00:00:00.000Z",
      dedupeKey: "default:system.disk:/:critical",
      title: "Disk usage critical",
    };

    await processor.processCheck(failingCheck);
    await processor.processCheck({ ...failingCheck, observedAt: "2026-04-02T00:01:00.000Z" });
    await processor.processCheck({
      ...failingCheck,
      status: "healthy",
      severity: "info",
      summary: "Disk usage is at 61%",
      observedAt: "2026-04-02T00:02:00.000Z",
      dedupeKey: "default:system.disk:/:healthy",
    });

    const incidents = listIncidents("default");
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      status: "resolved",
      event_count: 2,
      title: "Disk usage critical",
    });

    const detail = getIncidentDetail("default", incidents[0].id);
    expect(detail?.events.map((event) => event.event_type)).toEqual(["resolved", "opened"]);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ eventType: "opened" });
    expect(notify.mock.calls[1]?.[0]).toMatchObject({ eventType: "resolved" });
  });
});
