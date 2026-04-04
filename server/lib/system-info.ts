import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { env } from "./env.js";
import { HttpError } from "./errors.js";
import { runCommand } from "./process.js";

function getMemoryInfo(): { totalKb: number; availableKb: number } {
  if (process.platform === "linux") {
    try {
      const raw = fs.readFileSync("/proc/meminfo", "utf8");
      const parsed: Record<string, number> = {};
      for (const line of raw.split("\n")) {
        const match = line.match(/^([^:]+):\s+(\d+)/);
        if (match) {
          parsed[match[1]] = Number(match[2]);
        }
      }
      return {
        totalKb: parsed.MemTotal ?? 0,
        availableKb: parsed.MemAvailable ?? parsed.MemFree ?? 0,
      };
    } catch {
      // Fall through to cross-platform fallback
    }
  }

  return {
    totalKb: Math.round(os.totalmem() / 1024),
    availableKb: Math.round(os.freemem() / 1024),
  };
}

function getLoadAvg(): { load1: number; load5: number; load15: number } {
  const [load1, load5, load15] = os.loadavg();
  return { load1, load5, load15 };
}

export async function getDiskUsage(): Promise<{
  filesystem: string;
  sizeKb: number;
  usedKb: number;
  availableKb: number;
  usePercent: number;
  mount: string;
}> {
  const { stdout } = await runCommand("df", ["-kP", env.openclawHome]);
  const lines = stdout.trim().split("\n");
  const line = lines[1];
  if (!line) {
    throw new HttpError("Unable to read disk usage", 500);
  }

  const [filesystem, sizeKb, usedKb, availableKb, usePercent, mount] = line.trim().split(/\s+/);
  return {
    filesystem,
    sizeKb: Number(sizeKb),
    usedKb: Number(usedKb),
    availableKb: Number(availableKb),
    usePercent: Number(usePercent.replace("%", "")),
    mount,
  };
}

export async function getSystemHealth(): Promise<{
  cpu: { load1: number; load5: number; load15: number; cores: number };
  memory: {
    totalKb: number;
    availableKb: number;
    usedKb: number;
    usedPercent: number;
  };
  disk: Awaited<ReturnType<typeof getDiskUsage>>;
  uptimeSeconds: number;
}> {
  const { totalKb, availableKb } = getMemoryInfo();
  const loadAvg = getLoadAvg();
  const usedKb = Math.max(totalKb - availableKb, 0);
  const disk = await getDiskUsage();

  return {
    cpu: {
      load1: loadAvg.load1,
      load5: loadAvg.load5,
      load15: loadAvg.load15,
      cores: os.cpus().length,
    },
    memory: {
      totalKb,
      availableKb,
      usedKb,
      usedPercent: totalKb === 0 ? 0 : Number(((usedKb / totalKb) * 100).toFixed(2)),
    },
    disk,
    uptimeSeconds: os.uptime(),
  };
}

export async function getUserServices(): Promise<string> {
  if (process.platform === "linux") {
    const { stdout } = await runCommand("systemctl", ["--user", "list-units", "--type=service", "--all", "--no-pager"]);
    return stdout;
  }

  if (process.platform === "darwin") {
    const { stdout } = await runCommand("launchctl", ["list"]);
    return stdout;
  }

  return "Service listing not supported on this platform";
}

export async function getTailscaleStatus(): Promise<string> {
  const { stdout } = await runCommand("tailscale", ["status"]);
  return stdout;
}

export async function getGatewayModels(): Promise<unknown> {
  const response = await fetch(`${env.gatewayUrl}/v1/models`, {
    headers: {
      Authorization: `Bearer ${env.gatewayToken}`,
    },
  });

  if (!response.ok) {
    throw new HttpError(`Gateway model request failed with ${response.status}`, response.status);
  }

  return response.json();
}

export async function getOpenClawVersionAndPid(): Promise<{ version: string | null; pid: number | null }> {
  const versionPath = path.join(env.openclawHome, "update-check.json");
  let version: string | null = null;

  if (fs.existsSync(versionPath)) {
    const raw = JSON.parse(fs.readFileSync(versionPath, "utf8")) as { currentVersion?: string };
    version = raw.currentVersion ?? null;
  }

  // Try systemctl on Linux
  if (process.platform === "linux") {
    try {
      const { stdout } = await runCommand("systemctl", [
        "--user",
        "show",
        "openclaw-gateway.service",
        "--property",
        "MainPID",
        "--value",
      ]);
      const pid = stdout.trim() ? Number(stdout.trim()) : null;
      return { version, pid: pid && pid > 0 ? pid : null };
    } catch {
      return { version, pid: null };
    }
  }

  // Cross-platform fallback: find the gateway process by port
  try {
    const port = new URL(env.gatewayUrl).port || "18789";
    const { stdout } = await runCommand("lsof", ["-ti", `tcp:${port}`]);
    const pid = stdout.trim() ? Number(stdout.trim().split("\n")[0]) : null;
    return { version, pid: pid && pid > 0 ? pid : null };
  } catch {
    return { version, pid: null };
  }
}

export async function getQmdStatusOutput(): Promise<string> {
  const { stdout } = await runCommand("qmd", ["status"]);
  return stdout;
}

export async function runQmdSearch(query: string, collection: string): Promise<string> {
  const { stdout } = await runCommand("qmd", ["search", query, "-c", collection, "--json"]);
  return stdout;
}

export async function startQmdUpdate(): Promise<void> {
  const proc = await import("node:child_process");
  const subprocess = proc.spawn("qmd", ["update"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  subprocess.unref();
}
