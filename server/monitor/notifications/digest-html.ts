import type { DigestData } from "./digest.js";

function severityColor(severity: string): string {
  switch (severity) {
    case "critical": return "#ef4444";
    case "warning": return "#f59e0b";
    default: return "#6b7280";
  }
}

function severityBadge(severity: string): string {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;color:#fff;background:${severityColor(severity)}">${severity.toUpperCase()}</span>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}

export function renderDigestHtml(data: DigestData): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  let body = "";

  if (data.allClear) {
    body = `
      <div style="text-align:center;padding:60px 20px;">
        <div style="font-size:48px;margin-bottom:16px;">&#x2705;</div>
        <h2 style="color:#10b981;margin:0;">All Clear</h2>
        <p style="color:#6b7280;margin-top:8px;">No incidents in the last 24 hours.</p>
      </div>
    `;
  } else {
    if (data.needsHumanAction.length > 0) {
      body += `
        <div style="margin-bottom:32px;">
          <h2 style="color:#ef4444;font-size:16px;text-transform:uppercase;letter-spacing:1px;margin:0 0 16px 0;padding-bottom:8px;border-bottom:2px solid #ef4444;">
            &#x26A0; Action Required (${data.needsHumanAction.length})
          </h2>
          ${data.needsHumanAction.map((i) => `
            <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin-bottom:12px;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                ${severityBadge(i.severity)}
                <strong style="color:#1f2937;">${esc(i.title)}</strong>
              </div>
              <p style="color:#4b5563;margin:0 0 8px 0;font-size:14px;">${esc(i.summary)}</p>
              <p style="color:#9ca3af;margin:0;font-size:12px;">Open since ${formatTime(i.opened_at)}</p>
            </div>
          `).join("")}
        </div>
      `;
    }

    const nonActionable = data.currentlyOpen.filter(
      (i) => !data.needsHumanAction.some((a) => a.id === i.id),
    );

    if (nonActionable.length > 0) {
      body += `
        <div style="margin-bottom:32px;">
          <h2 style="color:#f59e0b;font-size:16px;text-transform:uppercase;letter-spacing:1px;margin:0 0 16px 0;padding-bottom:8px;border-bottom:2px solid #f59e0b;">
            Open Issues (${nonActionable.length})
          </h2>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="text-align:left;border-bottom:1px solid #e5e7eb;">
                <th style="padding:8px 12px;color:#6b7280;font-size:12px;font-weight:600;">SEVERITY</th>
                <th style="padding:8px 12px;color:#6b7280;font-size:12px;font-weight:600;">INCIDENT</th>
                <th style="padding:8px 12px;color:#6b7280;font-size:12px;font-weight:600;">SINCE</th>
              </tr>
            </thead>
            <tbody>
              ${nonActionable.map((i) => `
                <tr style="border-bottom:1px solid #f3f4f6;">
                  <td style="padding:10px 12px;">${severityBadge(i.severity)}</td>
                  <td style="padding:10px 12px;color:#1f2937;font-size:14px;">${esc(i.title)}</td>
                  <td style="padding:10px 12px;color:#9ca3af;font-size:13px;">${formatTime(i.opened_at)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `;
    }

    if (data.resolvedLast24h.length > 0) {
      body += `
        <div style="margin-bottom:32px;">
          <h2 style="color:#10b981;font-size:16px;text-transform:uppercase;letter-spacing:1px;margin:0 0 16px 0;padding-bottom:8px;border-bottom:2px solid #10b981;">
            &#x2705; Auto-Resolved (${data.resolvedLast24h.length})
          </h2>
          <table style="width:100%;border-collapse:collapse;">
            <tbody>
              ${data.resolvedLast24h.map((i) => `
                <tr style="border-bottom:1px solid #f3f4f6;">
                  <td style="padding:8px 12px;color:#6b7280;font-size:14px;">${esc(i.title)}</td>
                  <td style="padding:8px 12px;color:#9ca3af;font-size:13px;text-align:right;">Resolved ${formatTime(i.resolved_at!)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `;
    }
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      margin: 0;
      padding: 0;
      background: #ffffff;
      color: #1f2937;
    }
  </style>
</head>
<body>
  <div style="max-width:640px;margin:0 auto;padding:40px 32px;">
    <!-- Header -->
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
      <div style="width:36px;height:36px;background:#4f46e5;border-radius:8px;display:flex;align-items:center;justify-content:center;">
        <span style="color:#fff;font-size:18px;font-weight:700;">C</span>
      </div>
      <div>
        <h1 style="margin:0;font-size:20px;font-weight:700;color:#1f2937;">ClawMonitor</h1>
      </div>
    </div>
    <p style="color:#6b7280;font-size:14px;margin:0 0 32px 0;">${esc(dateStr)}</p>

    <!-- Summary bar -->
    <div style="display:flex;gap:16px;margin-bottom:32px;">
      <div style="flex:1;background:#f9fafb;border-radius:8px;padding:16px;text-align:center;">
        <div style="font-size:28px;font-weight:700;color:${data.currentlyOpen.length > 0 ? "#ef4444" : "#10b981"}">${data.currentlyOpen.length}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px;">Open</div>
      </div>
      <div style="flex:1;background:#f9fafb;border-radius:8px;padding:16px;text-align:center;">
        <div style="font-size:28px;font-weight:700;color:#f59e0b">${data.openedLast24h.length}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px;">Opened (24h)</div>
      </div>
      <div style="flex:1;background:#f9fafb;border-radius:8px;padding:16px;text-align:center;">
        <div style="font-size:28px;font-weight:700;color:#10b981">${data.resolvedLast24h.length}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px;">Resolved (24h)</div>
      </div>
    </div>

    ${body}

    <!-- Footer -->
    <div style="margin-top:40px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center;">
      <p style="color:#9ca3af;font-size:12px;margin:0;">Generated by ClawMonitor &middot; OpenClaw Observability</p>
    </div>
  </div>
</body>
</html>`;
}
