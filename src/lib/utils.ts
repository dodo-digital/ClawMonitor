import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatKb(kb: number): string {
  return formatBytes(kb * 1024);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function formatTimestamp(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function channelColor(channel: string): string {
  const colors: Record<string, string> = {
    telegram: "bg-channel-telegram",
    webchat: "bg-channel-webchat",
    cron: "bg-channel-cron",
    hook: "bg-channel-hook",
    slack: "bg-channel-slack",
    main: "bg-channel-main",
  };
  return colors[channel] ?? "bg-channel-unknown";
}

export function channelTextColor(channel: string): string {
  const colors: Record<string, string> = {
    telegram: "text-channel-telegram",
    webchat: "text-channel-webchat",
    cron: "text-channel-cron",
    hook: "text-channel-hook",
    slack: "text-channel-slack",
    main: "text-channel-main",
  };
  return colors[channel] ?? "text-channel-unknown";
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

export function percentColor(pct: number): string {
  if (pct < 70) return "bg-healthy";
  if (pct < 90) return "bg-warning";
  return "bg-error";
}

// Topic ID → human-readable label. Populated from /api/agents bindings data.
const topicLabels = new Map<string, string>([
  // Defaults for known topics (overridden by setTopicLabels if API data loads)
  ["1", "General"],
  ["2", "General 2"],
  ["205", "Goals"],
]);

/** Call once with agent data to populate topic labels from binding configs. */
export function setTopicLabels(agents: Array<{ id: string; telegramBinding: unknown }>) {
  for (const agent of agents) {
    const binding = agent.telegramBinding as Record<string, unknown> | null;
    if (!binding) continue;
    const match = binding.match as Record<string, unknown> | undefined;
    const peer = match?.peer as Record<string, unknown> | undefined;
    const peerId = peer?.id as string | undefined;
    const label = (binding.acp as Record<string, unknown> | undefined)?.label as string | undefined;
    if (peerId && label) {
      const topicMatch = peerId.match(/topic:(\d+)/);
      if (topicMatch) {
        topicLabels.set(topicMatch[1], label);
      }
    }
  }
}

/**
 * Turn a raw session key like "agent:direct:telegram:group:-1003691004254:topic:1"
 * into something a human can read like "Telegram — General".
 */
export function formatSessionName(sessionKey: string, channel: string): string {
  // Strip the "agent:<agentId>:" prefix
  const stripped = sessionKey.replace(/^agent:[^:]+:/, "");

  // Named sessions
  if (stripped === "main") return "Main Session (Control UI)";
  if (stripped === "paperclip") return "Paperclip";

  // Telegram sessions — resolve topic to label
  if (channel === "telegram") {
    const topicMatch = stripped.match(/topic:(\d+)/);
    if (topicMatch) {
      const label = topicLabels.get(topicMatch[1]);
      if (label) return `Telegram — ${capitalize(label)}`;
      return `Telegram — Topic ${topicMatch[1]}`;
    }
    return "Telegram DM";
  }

  // Cron sessions
  if (channel === "cron") {
    const cronIdMatch = stripped.match(/cron:([a-f0-9-]+)/);
    if (cronIdMatch) {
      const shortId = cronIdMatch[1].slice(0, 8);
      if (stripped.includes(":run:")) return `Cron Sub-run (${shortId})`;
      return `Cron Run (${shortId})`;
    }
    return "Cron Run";
  }

  // Webchat, hook, slack
  if (stripped.length > 30) {
    return `${capitalize(channel)} Session`;
  }

  return capitalize(stripped.replace(/[:-]/g, " ").trim());
}

// Turn a cron expression into a human-readable string
export function humanCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  // Every N minutes
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const n = Number(min.slice(2));
    return n === 1 ? "Every minute" : `Every ${n} minutes`;
  }

  // Every N hours
  if (hour.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    const n = Number(hour.slice(2));
    const atMin = min === "0" ? "" : ` at :${min.padStart(2, "0")}`;
    return (n === 1 ? "Every hour" : `Every ${n} hours`) + atMin;
  }

  // Specific time daily
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") {
    return `Daily at ${fmtHourMin(Number(hour), Number(min))}`;
  }

  // Specific time on certain days of week
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow !== "*") {
    const days = expandDow(dow);
    return `${days} at ${fmtHourMin(Number(hour), Number(min))}`;
  }

  // Hourly at specific minute
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Hourly at :${min.padStart(2, "0")}`;
  }

  return expr;
}

function fmtHourMin(h: number, m: number): string {
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function expandDow(dow: string): string {
  // Handle ranges like 1-5 and lists like 0,6
  const nums: number[] = [];
  for (const part of dow.split(",")) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      for (let i = a; i <= b; i++) nums.push(i);
    } else {
      nums.push(Number(part));
    }
  }
  if (nums.length === 5 && !nums.includes(0) && !nums.includes(6)) return "Weekdays";
  if (nums.length === 2 && nums.includes(0) && nums.includes(6)) return "Weekends";
  return nums.map((n) => dowNames[n] ?? n).join(", ");
}

/** Format a date/timestamp to local human-readable: "Apr 2, 3:15 PM" */
export function formatLocal(dateStr: string | number): string {
  const d = typeof dateStr === "number" ? new Date(dateStr) : new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Extract an ISO-ish date from a string, return formatted local time or null */
export function extractAndFormatDate(s: string): string | null {
  const match = s.match(/(\d{4}-\d{2}-\d{2}T?\d{2}:\d{2})/);
  if (!match) return null;
  return formatLocal(match[1] + ":00Z");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
