import fs from "node:fs";

import { db } from "../../lib/db.js";
import type { IncidentRecord } from "../types.js";
import { DEFAULT_WORKSPACE_ID } from "../workspace.js";
import { recordNotificationDelivery } from "./delivery-store.js";
import { generateDigestImage } from "./digest-pdf.js";
import type { TelegramDestination } from "./telegram.js";
import type { NotificationDestination } from "./types.js";

type DigestIncident = IncidentRecord & { event_count: number };

export type DigestData = {
  currentlyOpen: DigestIncident[];
  openedLast24h: DigestIncident[];
  resolvedLast24h: DigestIncident[];
  needsHumanAction: DigestIncident[];
  allClear: boolean;
};

export function gatherDigestData(workspaceId: string = DEFAULT_WORKSPACE_ID): DigestData {
  const currentlyOpen = db
    .prepare(
      `
      SELECT i.*, COUNT(e.id) AS event_count
      FROM incidents i
      LEFT JOIN incident_events e ON e.incident_id = i.id
      WHERE i.workspace_id = ? AND i.status != 'resolved'
      GROUP BY i.id
      ORDER BY
        CASE i.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        i.last_seen_at DESC
    `,
    )
    .all(workspaceId) as DigestIncident[];

  const openedLast24h = db
    .prepare(
      `
      SELECT i.*, COUNT(e.id) AS event_count
      FROM incidents i
      LEFT JOIN incident_events e ON e.incident_id = i.id
      WHERE i.workspace_id = ?
        AND (julianday('now') - julianday(i.opened_at)) * 24 < 24
      GROUP BY i.id
      ORDER BY i.opened_at DESC
    `,
    )
    .all(workspaceId) as DigestIncident[];

  const resolvedLast24h = db
    .prepare(
      `
      SELECT i.*, COUNT(e.id) AS event_count
      FROM incidents i
      LEFT JOIN incident_events e ON e.incident_id = i.id
      WHERE i.workspace_id = ?
        AND i.status = 'resolved'
        AND (julianday('now') - julianday(i.resolved_at)) * 24 < 24
      GROUP BY i.id
      ORDER BY i.resolved_at DESC
    `,
    )
    .all(workspaceId) as DigestIncident[];

  // Needs human action: critical incidents open > 1 hour
  const needsHumanAction = currentlyOpen.filter(
    (i) => i.severity === "critical" && Date.now() - Date.parse(i.opened_at) > 60 * 60_000,
  );

  const allClear = currentlyOpen.length === 0 && openedLast24h.length === 0;

  return { currentlyOpen, openedLast24h, resolvedLast24h, needsHumanAction, allClear };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

export function formatDigestTelegram(data: DigestData): string {
  const lines: string[] = [];

  lines.push("*ClawMonitor Daily Digest*");
  lines.push("");

  if (data.allClear) {
    lines.push(esc("All clear — no incidents in the last 24 hours."));
    return lines.join("\n");
  }

  if (data.needsHumanAction.length > 0) {
    lines.push(`*ACTION REQUIRED \\(${data.needsHumanAction.length}\\):*`);
    for (const i of data.needsHumanAction) {
      lines.push(`  \\[${esc(i.severity)}\\] ${esc(i.title)}`);
      lines.push(`    ${esc(i.summary)}`);
    }
    lines.push("");
  }

  if (data.currentlyOpen.length > 0) {
    const nonActionable = data.currentlyOpen.filter(
      (i) => !data.needsHumanAction.some((a) => a.id === i.id),
    );
    if (nonActionable.length > 0) {
      lines.push(`*Open \\(${nonActionable.length}\\):*`);
      for (const i of nonActionable) {
        lines.push(`  \\[${esc(i.severity)}\\] ${esc(i.title)}`);
      }
      lines.push("");
    }
  }

  if (data.resolvedLast24h.length > 0) {
    lines.push(`*Auto\\-resolved \\(${data.resolvedLast24h.length}\\):*`);
    for (const i of data.resolvedLast24h) {
      lines.push(`  ${esc(i.title)}`);
    }
    lines.push("");
  }

  lines.push(esc(`Summary: ${data.openedLast24h.length} opened, ${data.resolvedLast24h.length} resolved in last 24h.`));

  return lines.join("\n");
}

export function formatDigestPlaintext(data: DigestData): string {
  const lines: string[] = [];

  lines.push("=== ClawMonitor Daily Digest ===");
  lines.push("");

  if (data.allClear) {
    lines.push("All clear — no incidents in the last 24 hours.");
    return lines.join("\n");
  }

  if (data.needsHumanAction.length > 0) {
    lines.push(`ACTION REQUIRED (${data.needsHumanAction.length}):`);
    for (const i of data.needsHumanAction) {
      lines.push(`  [${i.severity}] ${i.title}`);
      lines.push(`    ${i.summary}`);
      lines.push(`    Open since: ${i.opened_at}`);
    }
    lines.push("");
  }

  if (data.currentlyOpen.length > 0) {
    const nonActionable = data.currentlyOpen.filter(
      (i) => !data.needsHumanAction.some((a) => a.id === i.id),
    );
    if (nonActionable.length > 0) {
      lines.push(`CURRENTLY OPEN (${nonActionable.length}):`);
      for (const i of nonActionable) {
        lines.push(`  [${i.severity}] ${i.title}`);
      }
      lines.push("");
    }
  }

  if (data.resolvedLast24h.length > 0) {
    lines.push(`AUTO-RESOLVED (${data.resolvedLast24h.length}):`);
    for (const i of data.resolvedLast24h) {
      lines.push(`  ${i.title}`);
    }
    lines.push("");
  }

  lines.push(`Summary: ${data.openedLast24h.length} opened, ${data.resolvedLast24h.length} resolved in last 24h.`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Send digest to all enabled destinations
// ---------------------------------------------------------------------------

export async function sendDigest(destinations: NotificationDestination[]): Promise<void> {
  const data = gatherDigestData();
  const enabled = destinations.filter((d) => d.isEnabled());

  // Generate image once for destinations that support inline photos
  let imagePath: string | null = null;
  try {
    imagePath = await generateDigestImage(data);
  } catch (error) {
    console.error("[digest] Image generation failed, falling back to text", error);
  }

  for (const dest of enabled) {
    try {
      let result;

      // Telegram: send as inline photo
      if (dest.id === "telegram" && imagePath && "sendPhoto" in dest) {
        const caption = data.allClear
          ? esc("ClawMonitor Daily Digest — All clear")
          : esc(`ClawMonitor Daily Digest — ${data.currentlyOpen.length} open, ${data.resolvedLast24h.length} resolved`);
        result = await (dest as TelegramDestination).sendPhoto(imagePath, caption);
      } else if (dest.sendRaw) {
        // Destinations with sendRaw: use formatted text
        const text = dest.id === "telegram" ? formatDigestTelegram(data) : formatDigestPlaintext(data);
        result = await dest.sendRaw(text);
      } else {
        // Fallback: send via standard payload interface
        const text = formatDigestPlaintext(data);
        result = await dest.send({
          incident: {
            id: 0,
            workspace_id: DEFAULT_WORKSPACE_ID,
            dedupe_key: "digest",
            check_type: "digest",
            target_key: "daily",
            status: data.allClear ? "resolved" : "open",
            severity: data.needsHumanAction.length > 0 ? "critical" : "info",
            title: data.allClear ? "Daily Digest — All Clear" : `Daily Digest — ${data.currentlyOpen.length} open`,
            summary: text,
            opened_at: new Date().toISOString(),
            acknowledged_at: null,
            resolved_at: null,
            last_seen_at: new Date().toISOString(),
            acknowledged_by_user_id: null,
            resolution_note: null,
          },
          eventType: data.allClear ? "resolved" : "opened",
          check: {
            workspaceId: DEFAULT_WORKSPACE_ID,
            checkType: "digest",
            targetKey: "daily",
            status: data.allClear ? "healthy" : "failing",
            severity: data.needsHumanAction.length > 0 ? "critical" : "info",
            summary: text,
            evidence: {},
            observedAt: new Date().toISOString(),
            dedupeKey: "digest:daily",
            title: "Daily Digest",
          },
        });
      }

      try {
        recordNotificationDelivery({
          incidentId: 0,
          eventType: "digest",
          destinationId: dest.id,
          destinationName: dest.name,
          success: result.success,
          statusCode: result.statusCode ?? null,
          responseBody: result.responseBody ?? null,
          errorMessage: result.errorMessage ?? null,
        });
      } catch {
        // Ignore delivery recording errors
      }

      if (!result.success) {
        console.error(`[digest:${dest.id}] delivery failed: ${result.errorMessage}`);
      }
    } catch (error) {
      console.error(`[digest:${dest.id}] failed to send`, error);
    }
  }

  // Clean up image
  if (imagePath) {
    try { fs.unlinkSync(imagePath); } catch { /* ignore */ }
  }
}
