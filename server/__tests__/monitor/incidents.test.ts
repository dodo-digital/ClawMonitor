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

  it("applies exponential cooldown — blocks reopen within cooldown window", async () => {
    const notify = vi.fn(async () => {});
    const processor = new IncidentProcessor(notify);

    const now = Date.now();

    const failingCheck: MonitorCheckResultInput = {
      workspaceId: "default",
      checkType: "gateway.connection",
      targetKey: "gateway",
      status: "failing",
      severity: "critical",
      summary: "Gateway disconnected",
      evidence: {},
      observedAt: new Date(now).toISOString(),
      dedupeKey: "default:gateway.connection:gateway:disconnected",
      title: "Gateway disconnected",
    };

    const healthyCheck: MonitorCheckResultInput = {
      ...failingCheck,
      status: "healthy",
      severity: "info",
      summary: "Gateway connected",
      observedAt: new Date(now + 1000).toISOString(),
      dedupeKey: "default:gateway.connection:gateway:healthy",
    };

    // Open, then resolve
    await processor.processCheck(failingCheck);
    await processor.processCheck(healthyCheck);

    // Try to reopen immediately — should be blocked by cooldown
    await processor.processCheck({
      ...failingCheck,
      observedAt: new Date(now + 2000).toISOString(),
    });

    const incidents = listIncidents("default");
    // Should still be just 1 incident (the resolved one) — second open was blocked
    expect(incidents).toHaveLength(1);
    expect(incidents[0].status).toBe("resolved");
  });

  it("escalation check promotes old warnings to critical", async () => {
    const notify = vi.fn(async () => {});
    const processor = new IncidentProcessor(notify);

    // Insert a warning incident that's been open for 3 hours
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const recentSeen = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    db.prepare(
      `INSERT INTO incidents (workspace_id, dedupe_key, check_type, target_key, status, severity, title, summary, opened_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'open', 'warning', ?, ?, ?, ?)`,
    ).run(
      "default",
      "default:cron.job_status:test-job:status_error",
      "cron.job_status",
      "test-job",
      "Test job is failing",
      "Last run failed",
      threeHoursAgo,
      recentSeen,
    );

    await processor.runEscalationCheck();

    const incidents = listIncidents("default");
    const escalated = incidents.find((i) => i.title === "Test job is failing");
    expect(escalated).toBeDefined();
    expect(escalated!.severity).toBe("critical");

    // Should have sent an escalation notification
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "escalated" }),
    );
  });

  it("does NOT escalate warnings that are not old enough", async () => {
    const notify = vi.fn(async () => {});
    const processor = new IncidentProcessor(notify);

    // Insert a warning that's only 30 minutes old
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    db.prepare(
      `INSERT INTO incidents (workspace_id, dedupe_key, check_type, target_key, status, severity, title, summary, opened_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'open', 'warning', ?, ?, ?, ?)`,
    ).run(
      "default",
      "default:cron.job_status:recent-job:status_error",
      "cron.job_status",
      "recent-job",
      "Recent job failing",
      "Just started failing",
      thirtyMinAgo,
      thirtyMinAgo,
    );

    await processor.runEscalationCheck();

    const incidents = listIncidents("default");
    const notEscalated = incidents.find((i) => i.title === "Recent job failing");
    expect(notEscalated).toBeDefined();
    expect(notEscalated!.severity).toBe("warning");
    expect(notify).not.toHaveBeenCalled();
  });
});
