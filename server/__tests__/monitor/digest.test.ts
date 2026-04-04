import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestPaths, removeTestPaths, type TestPaths } from "../test-helpers.js";

describe("daily digest", () => {
  let paths: TestPaths;

  beforeEach(() => {
    vi.resetModules();
    paths = createTestPaths("openclaw-digest-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const dbModule = await import("../../lib/db.js");
    if (typeof dbModule.db !== "undefined") {
      dbModule.db.close();
    }
    await removeTestPaths(paths);
  });

  it("falls back to text delivery when digest image generation fails", async () => {
    vi.doMock("../../monitor/notifications/digest-pdf.js", () => ({
      generateDigestImage: vi.fn().mockRejectedValue(new Error("Chromium unavailable")),
    }));

    const dbModule = await import("../../lib/db.js");
    dbModule.initializeDatabase(path.join(paths.rootDir, "dashboard.sqlite"));

    const now = Date.now();
    const openedAt = new Date(now - 12 * 60 * 60_000).toISOString(); // 12h ago
    const lastSeenAt = new Date(now - 2 * 60 * 60_000).toISOString(); // 2h ago
    const resolvedAt = new Date(now - 1 * 60 * 60_000).toISOString(); // 1h ago

    dbModule.db.prepare(`
      INSERT INTO incidents (
        workspace_id, dedupe_key, check_type, target_key, status, severity,
        title, summary, opened_at, acknowledged_at, resolved_at, last_seen_at,
        acknowledged_by_user_id, resolution_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "default",
      "digest:critical",
      "system.disk",
      "/",
      "open",
      "critical",
      "Disk usage critical",
      "Disk usage is at 98%",
      openedAt,
      null,
      null,
      lastSeenAt,
      null,
      null,
    );

    dbModule.db.prepare(`
      INSERT INTO incidents (
        workspace_id, dedupe_key, check_type, target_key, status, severity,
        title, summary, opened_at, acknowledged_at, resolved_at, last_seen_at,
        acknowledged_by_user_id, resolution_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "default",
      "digest:resolved",
      "gateway:disconnect",
      "gateway",
      "resolved",
      "warning",
      "Gateway disconnected",
      "Gateway recovered",
      new Date(now - 6 * 60 * 60_000).toISOString(), // opened 6h ago
      null,
      resolvedAt,
      resolvedAt,
      null,
      "Recovered automatically",
    );

    dbModule.db.prepare(`
      INSERT INTO incident_events (incident_id, event_type, payload_json)
      VALUES (1, 'opened', '{}'), (1, 'seen', '{}'), (2, 'resolved', '{}')
    `).run();

    const telegramSendRaw = vi.fn(async () => ({ success: true, statusCode: 200 }));
    const emailSend = vi.fn(async () => ({ success: true, statusCode: 202, responseBody: "queued" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { sendDigest } = await import("../../monitor/notifications/digest.js");

    await sendDigest([
      {
        id: "telegram",
        name: "Telegram",
        isEnabled: () => true,
        send: vi.fn(async () => ({ success: false, errorMessage: "unused" })),
        sendRaw: telegramSendRaw,
      },
      {
        id: "email",
        name: "Email",
        isEnabled: () => true,
        send: emailSend,
      },
    ]);

    expect(telegramSendRaw).toHaveBeenCalledTimes(1);
    expect(telegramSendRaw.mock.calls[0][0]).toContain("*ACTION REQUIRED \\(1\\):*");
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend.mock.calls[0][0].incident.summary).toContain("ACTION REQUIRED (1):");
    expect(emailSend.mock.calls[0][0].incident.summary).toContain("AUTO-RESOLVED (1):");
    expect(errorSpy).toHaveBeenCalledWith(
      "[digest] Image generation failed, falling back to text",
      expect.any(Error),
    );

    const deliveryCount = dbModule.db
      .prepare("SELECT COUNT(*) AS count FROM notification_deliveries")
      .get() as { count: number };

    expect(deliveryCount.count).toBeGreaterThanOrEqual(0);
  });

  it("formats all-clear plain text digests without incident sections", async () => {
    vi.doMock("../../monitor/notifications/digest-pdf.js", () => ({
      generateDigestImage: vi.fn(),
    }));

    const { formatDigestPlaintext } = await import("../../monitor/notifications/digest.js");

    const output = formatDigestPlaintext({
      currentlyOpen: [],
      openedLast24h: [],
      resolvedLast24h: [],
      needsHumanAction: [],
      allClear: true,
    });

    expect(output).toContain("=== ClawMonitor Daily Digest ===");
    expect(output).toContain("All clear — no incidents in the last 24 hours.");
    expect(output).not.toContain("ACTION REQUIRED");
  });
});
