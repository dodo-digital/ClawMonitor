import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db, initializeDatabase } from "../../../lib/db.js";
import { NotificationDispatcher } from "../../../monitor/notifications/dispatcher.js";
import { listDeliveriesForIncident } from "../../../monitor/notifications/delivery-store.js";
import type { NotificationDeliveryResult, NotificationDestination, NotificationPayload } from "../../../monitor/notifications/types.js";
import { IncidentProcessor } from "../../../monitor/incidents/processor.js";
import type { MonitorCheckResultInput } from "../../../monitor/types.js";
import { makePayload } from "./fixtures.js";

class MockDestination implements NotificationDestination {
  readonly calls: NotificationPayload[] = [];

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly enabled: boolean,
    private readonly result: NotificationDeliveryResult,
  ) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    this.calls.push(payload);
    return this.result;
  }
}

describe("NotificationDispatcher", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dispatcher-"));
    initializeDatabase(path.join(rootDir, "dashboard.sqlite"));
  });

  afterEach(async () => {
    db.close();
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  it("fans out to all enabled destinations", async () => {
    const dest1 = new MockDestination("telegram", "Telegram", true, { success: true, statusCode: 200 });
    const dest2 = new MockDestination("slack", "Slack", true, { success: true, statusCode: 200 });
    const dest3 = new MockDestination("disabled", "Disabled", false, { success: true });

    const dispatcher = new NotificationDispatcher("realtime");
    dispatcher.register(dest1);
    dispatcher.register(dest2);
    dispatcher.register(dest3);

    const handler = dispatcher.toHandler();

    // We need a real incident in the DB for delivery recording
    const processor = new IncidentProcessor(handler);
    await processor.processCheck({
      workspaceId: "default",
      checkType: "system.disk",
      targetKey: "/",
      status: "failing",
      severity: "critical",
      summary: "Disk at 98%",
      evidence: {},
      observedAt: "2026-04-02T00:00:00.000Z",
      dedupeKey: "default:system.disk:/:critical",
      title: "Disk critical",
    });

    expect(dest1.calls).toHaveLength(1);
    expect(dest2.calls).toHaveLength(1);
    expect(dest3.calls).toHaveLength(0); // disabled, skipped
  });

  it("records delivery for each destination", async () => {
    const dest1 = new MockDestination("telegram", "Telegram", true, { success: true, statusCode: 200 });
    const dest2 = new MockDestination("webhook", "Webhook", true, { success: false, statusCode: 500, errorMessage: "Server error" });

    const dispatcher = new NotificationDispatcher("realtime");
    dispatcher.register(dest1);
    dispatcher.register(dest2);

    const processor = new IncidentProcessor(dispatcher.toHandler());
    await processor.processCheck({
      workspaceId: "default",
      checkType: "system.disk",
      targetKey: "/",
      status: "failing",
      severity: "critical",
      summary: "Disk at 98%",
      evidence: {},
      observedAt: "2026-04-02T00:00:00.000Z",
      dedupeKey: "default:system.disk:/:critical",
      title: "Disk critical",
    });

    // Get the incident ID
    const incident = db.prepare("SELECT id FROM incidents WHERE workspace_id = 'default' LIMIT 1").get() as { id: number };
    const deliveries = listDeliveriesForIncident(incident.id);

    expect(deliveries).toHaveLength(2);

    const telegramDelivery = deliveries.find((d) => d.destination_id === "telegram");
    expect(telegramDelivery?.success).toBe(1);
    expect(telegramDelivery?.status_code).toBe(200);

    const webhookDelivery = deliveries.find((d) => d.destination_id === "webhook");
    expect(webhookDelivery?.success).toBe(0);
    expect(webhookDelivery?.error_message).toBe("Server error");
  });

  it("does not throw when a destination throws", async () => {
    const throwingDest: NotificationDestination = {
      id: "broken",
      name: "Broken",
      isEnabled: () => true,
      send: async () => { throw new Error("BOOM"); },
    };

    const dispatcher = new NotificationDispatcher("realtime");
    dispatcher.register(throwingDest);

    const processor = new IncidentProcessor(dispatcher.toHandler());

    // Should not throw
    await processor.processCheck({
      workspaceId: "default",
      checkType: "system.disk",
      targetKey: "/",
      status: "failing",
      severity: "critical",
      summary: "Disk at 98%",
      evidence: {},
      observedAt: "2026-04-02T00:00:00.000Z",
      dedupeKey: "default:system.disk:/:critical",
      title: "Disk critical",
    });

    // Incident should still be created
    const incident = db.prepare("SELECT id FROM incidents WHERE workspace_id = 'default' LIMIT 1").get() as { id: number };
    expect(incident).toBeDefined();

    // Delivery should be recorded as failed
    const deliveries = listDeliveriesForIncident(incident.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].success).toBe(0);
    expect(deliveries[0].error_message).toBe("BOOM");
  });

  it("records deliveries on both open and resolve", async () => {
    const dest = new MockDestination("telegram", "Telegram", true, { success: true, statusCode: 200 });

    const dispatcher = new NotificationDispatcher("realtime");
    dispatcher.register(dest);

    const processor = new IncidentProcessor(dispatcher.toHandler());

    const failingCheck: MonitorCheckResultInput = {
      workspaceId: "default",
      checkType: "system.disk",
      targetKey: "/",
      status: "failing",
      severity: "critical",
      summary: "Disk at 98%",
      evidence: {},
      observedAt: "2026-04-02T00:00:00.000Z",
      dedupeKey: "default:system.disk:/:critical",
      title: "Disk critical",
    };

    await processor.processCheck(failingCheck);
    await processor.processCheck({
      ...failingCheck,
      status: "healthy",
      severity: "info",
      summary: "Disk at 60%",
      observedAt: "2026-04-02T01:00:00.000Z",
      dedupeKey: "default:system.disk:/:healthy",
    });

    expect(dest.calls).toHaveLength(2);
    expect(dest.calls[0].eventType).toBe("opened");
    expect(dest.calls[1].eventType).toBe("resolved");

    const incident = db.prepare("SELECT id FROM incidents WHERE workspace_id = 'default' LIMIT 1").get() as { id: number };
    const deliveries = listDeliveriesForIncident(incident.id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((d) => d.event_type).sort()).toEqual(["opened", "resolved"]);
  });
});
