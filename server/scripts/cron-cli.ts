#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import yaml from "js-yaml";

type RegistryExpects = {
  exit_code?: number;
  log_contains?: string;
  log_not_contains?: string;
};

type RegistryJob = {
  id: string;
  name: string;
  schedule: string;
  layer: "linux" | "openclaw";
  enabled: boolean;
  category: string;
  command: string;
  log?: string;
  openclaw_id?: string;
  description: string;
  expects?: RegistryExpects;
  needs_ai: boolean;
};

type RegistryFile = {
  jobs?: RegistryJob[];
  archived?: RegistryJob[];
};

type OpenClawJob = {
  id: string;
  name?: string;
  enabled?: boolean;
  agentId?: string;
  sessionTarget?: string;
  wakeMode?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  schedule?: Record<string, unknown>;
  payload?: {
    kind?: string;
    message?: string;
    text?: string;
    thinking?: string;
    timeoutSeconds?: number;
  };
  delivery?: {
    mode?: string;
    channel?: string;
  };
  state?: {
    lastStatus?: string;
    lastRunAtMs?: number;
    lastDurationMs?: number;
    consecutiveErrors?: number;
    lastError?: string;
  };
};

type OpenClawJobsFile = {
  version?: number;
  jobs?: OpenClawJob[];
};

type RunEntry = {
  ts?: number;
  jobId?: string;
  action?: string;
  status?: string;
  summary?: string;
  runAtMs?: number;
  durationMs?: number;
  sessionKey?: string;
  startedAt?: string;
  timestamp?: string;
};

const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? path.join(process.env.HOME ?? "/root", ".openclaw");
const REGISTRY = path.join(OPENCLAW_HOME, "cron", "registry.yaml");
const JOBS_JSON = path.join(OPENCLAW_HOME, "cron", "jobs.json");
const RUNS_DIR = path.join(OPENCLAW_HOME, "cron", "runs");

function die(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function requireRegistry(): void {
  if (!fs.existsSync(REGISTRY)) {
    die(`Registry not found at ${REGISTRY}`);
  }
}

function readRegistry(): RegistryFile {
  const raw = fs.readFileSync(REGISTRY, "utf8");
  return (yaml.load(raw) as RegistryFile | undefined) ?? {};
}

function writeRegistry(data: RegistryFile): void {
  const raw = yaml.dump(data, {
    sortKeys: false,
    lineWidth: 120,
    noRefs: true,
    quotingType: '"',
  });
  fs.writeFileSync(REGISTRY, raw, "utf8");
}

function registryJobs(): RegistryJob[] {
  return readRegistry().jobs ?? [];
}

function getJob(jobId: string): RegistryJob | undefined {
  return registryJobs().find((job) => job.id === jobId);
}

function readJobsJson(): OpenClawJobsFile {
  return JSON.parse(fs.readFileSync(JOBS_JSON, "utf8")) as OpenClawJobsFile;
}

function writeJobsJson(data: OpenClawJobsFile): void {
  fs.writeFileSync(JOBS_JSON, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readRunHistory(job: RegistryJob): RunEntry[] {
  if (!job.openclaw_id) {
    return [];
  }

  const runFile = path.join(RUNS_DIR, `${job.openclaw_id}.jsonl`);
  if (!fs.existsSync(runFile)) {
    return [];
  }

  return fs
    .readFileSync(runFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RunEntry];
      } catch {
        return [];
      }
    });
}

function findOpenClawState(openclawId: string | undefined): OpenClawJob["state"] | null {
  if (!openclawId || !fs.existsSync(JOBS_JSON)) {
    return null;
  }

  try {
    const jobs = readJobsJson().jobs ?? [];
    return jobs.find((job) => job.id === openclawId)?.state ?? null;
  } catch {
    return null;
  }
}

function tailLines(targetPath: string, lines: number): string {
  const content = fs
    .readFileSync(targetPath, "utf8")
    .split("\n")
    .filter((line, index, all) => line.length > 0 || index < all.length - 1);
  return content.slice(-lines).join("\n").replace(/\n$/, "");
}

function printTable(rows: Array<Array<string | number>>, headers: string[]): void {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)),
  );
  const format = (row: Array<string | number>) =>
    row.map((value, index) => String(value ?? "").padEnd(widths[index])).join("  ");

  console.log(format(headers));
  console.log(format(widths.map((width) => "-".repeat(width))));
  for (const row of rows) {
    console.log(format(row));
  }
}

function shell(command: string, options?: { input?: string }): { status: number; output: string } {
  const result = spawnSync(process.env.SHELL ?? "bash", ["-lc", command], {
    encoding: "utf8",
    input: options?.input,
  });

  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd(),
  };
}

function readCrontab(): string {
  const result = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout ?? "";
}

function writeCrontab(content: string): void {
  const result = spawnSync("crontab", ["-"], {
    encoding: "utf8",
    input: content,
  });

  if (result.status !== 0) {
    die((result.stderr ?? result.stdout ?? "Failed to update crontab").trim());
  }
}

function listHealth(job: RegistryJob): "healthy" | "failing" | "disabled" | "unknown" {
  if (!job.enabled) {
    return "disabled";
  }

  if (job.layer === "linux") {
    if (!job.log) {
      return "unknown";
    }
    try {
      const content = fs.readFileSync(job.log, "utf8");
      if (job.expects?.log_not_contains && content.includes(job.expects.log_not_contains)) {
        return "failing";
      }
      if (job.expects?.log_contains && !content.includes(job.expects.log_contains)) {
        return "failing";
      }
      return "healthy";
    } catch {
      return "unknown";
    }
  }

  const runs = readRunHistory(job);
  const lastRun = runs.at(-1);
  if (lastRun?.status === "ok") {
    return "healthy";
  }
  if (lastRun?.status === "error") {
    return "failing";
  }

  const state = findOpenClawState(job.openclaw_id);
  if (state?.lastStatus === "ok") {
    return "healthy";
  }
  if (state?.lastStatus === "error") {
    return "failing";
  }

  return "unknown";
}

function cmdList(args: string[]): void {
  let layerFilter = "all";
  let categoryFilter = "";
  let statusFilter = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--layer") {
      layerFilter = args[index + 1] ?? die("Missing value for --layer");
      index += 1;
      continue;
    }
    if (arg === "--category") {
      categoryFilter = args[index + 1] ?? die("Missing value for --category");
      index += 1;
      continue;
    }
    if (arg === "--status") {
      statusFilter = args[index + 1] ?? die("Missing value for --status");
      index += 1;
      continue;
    }
    die(`Unknown option: ${arg}`);
  }

  const rows = registryJobs()
    .filter((job) => layerFilter === "all" || job.layer === layerFilter)
    .filter((job) => !categoryFilter || job.category === categoryFilter)
    .flatMap((job) => {
      const health = listHealth(job);
      if (statusFilter === "disabled" && job.enabled) {
        return [];
      }
      if (statusFilter === "healthy" && health !== "healthy") {
        return [];
      }
      if (statusFilter === "failing" && health !== "failing") {
        return [];
      }
      return [[job.id, job.layer, job.enabled ? "ON" : "OFF", health, job.category, job.schedule, job.name]];
    });

  if (rows.length === 0) {
    console.log("No jobs match the filters.");
    return;
  }

  printTable(rows, ["ID", "LAYER", "ON", "HEALTH", "CATEGORY", "SCHEDULE", "NAME"]);
  console.log(`\n${rows.length} job(s)`);
}

function cmdShow(jobId?: string): void {
  if (!jobId) {
    die("Usage: cron-cli show <id>");
  }

  const job = getJob(jobId);
  if (!job) {
    console.log(`Job not found: ${jobId}`);
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log(`Job: ${job.id}`);
  console.log("=".repeat(60));
  console.log(`  Name:        ${job.name ?? ""}`);
  console.log(`  Layer:       ${job.layer ?? ""}`);
  console.log(`  Schedule:    ${job.schedule ?? ""}`);
  console.log(`  Enabled:     ${job.enabled ?? false}`);
  console.log(`  Category:    ${job.category ?? ""}`);
  console.log(`  Needs AI:    ${job.needs_ai ?? false}`);
  console.log(`  Description: ${job.description ?? ""}`);
  console.log("");

  if (job.layer === "linux") {
    console.log(`  Command: ${job.command ?? ""}`);
    console.log(`  Log:     ${job.log ?? ""}`);
    if (job.log && fs.existsSync(job.log)) {
      const stat = fs.statSync(job.log);
      console.log(`  Log size:    ${stat.size} bytes`);
      console.log(`  Log updated: ${formatDateTime(stat.mtime)}`);
    }
    console.log("");

    if (job.log && fs.existsSync(job.log)) {
      const content = fs.readFileSync(job.log, "utf8");
      const issues: string[] = [];
      if (job.expects?.log_not_contains && content.includes(job.expects.log_not_contains)) {
        issues.push(`Log contains forbidden text: "${job.expects.log_not_contains}"`);
      }
      if (job.expects?.log_contains && !content.includes(job.expects.log_contains)) {
        issues.push(`Log missing expected text: "${job.expects.log_contains}"`);
      }

      if (issues.length > 0) {
        console.log("  HEALTH: FAILING");
        for (const issue of issues) {
          console.log(`    - ${issue}`);
        }
      } else {
        console.log("  HEALTH: HEALTHY");
      }
    }
    console.log("");
    return;
  }

  console.log(`  OpenClaw ID: ${job.openclaw_id ?? ""}`);
  console.log(`  Prompt:      ${job.command.slice(0, 120)}...`);
  console.log("");

  const runs = readRunHistory(job);
  if (runs.length > 0) {
    console.log("  Last runs:");
    for (const run of runs.slice(-5)) {
      const timestamp = run.startedAt ?? run.timestamp ?? "?";
      const duration = typeof run.durationMs === "number" ? `${(run.durationMs / 1000).toFixed(1)}s` : String(run.durationMs ?? "?");
      console.log(`    ${timestamp}  status=${run.status ?? "?"}  duration=${duration}`);
    }
    console.log("");
  }

  const state = findOpenClawState(job.openclaw_id);
  if (state) {
    console.log("  State from jobs.json:");
    if (state.lastRunAtMs) {
      console.log(`    Last run:    ${formatDateTime(new Date(state.lastRunAtMs))}`);
    }
    console.log(`    Status:      ${state.lastStatus ?? ""}`);
    if (state.lastDurationMs) {
      console.log(`    Duration:    ${(state.lastDurationMs / 1000).toFixed(1)}s`);
    }
    if (state.consecutiveErrors) {
      console.log(`    Consec errs: ${state.consecutiveErrors}`);
    }
    if (state.lastError) {
      console.log(`    Last error:  ${state.lastError}`);
    }
    const health = state.lastStatus === "ok" ? "HEALTHY" : state.lastStatus === "error" ? "FAILING" : "UNKNOWN";
    console.log(`    HEALTH:      ${health}`);
  }
  console.log("");
}

function cmdLogs(jobId?: string, args: string[] = []): void {
  if (!jobId) {
    die("Usage: cron-cli logs <id> [--lines N]");
  }

  let lines = 30;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--lines") {
      lines = Number(args[index + 1] ?? die("Missing value for --lines"));
      index += 1;
      continue;
    }
    die(`Unknown option: ${arg}`);
  }

  const job = getJob(jobId);
  if (!job) {
    die(`Job not found: ${jobId}`);
  }

  if (job.layer === "linux") {
    if (!job.log || !fs.existsSync(job.log)) {
      console.log(`No log file found for ${jobId}`);
      process.exit(1);
    }
    console.log(`=== ${job.log} (last ${lines} lines) ===`);
    console.log(tailLines(job.log, lines));
    return;
  }

  const runFile = path.join(RUNS_DIR, `${job.openclaw_id}.jsonl`);
  if (!fs.existsSync(runFile)) {
    console.log(`No run history found for ${jobId} (openclaw_id: ${job.openclaw_id ?? ""})`);
    process.exit(1);
  }

  console.log(`=== ${runFile} (last ${lines} lines) ===`);
  console.log(tailLines(runFile, lines));
}

function healthRow(job: RegistryJob): [string, string, string] {
  if (!job.enabled) {
    return [job.id, "DISABLED", "-"];
  }

  if (job.layer === "linux") {
    if (!job.log || !fs.existsSync(job.log)) {
      return [job.id, "UNKNOWN", "No log file"];
    }

    const content = fs.readFileSync(job.log, "utf8");
    const issues: string[] = [];
    if (job.expects?.log_not_contains && content.includes(job.expects.log_not_contains)) {
      issues.push(`contains "${job.expects.log_not_contains}"`);
    }
    if (job.expects?.log_contains && !content.includes(job.expects.log_contains)) {
      issues.push(`missing "${job.expects.log_contains}"`);
    }
    if (issues.length > 0) {
      return [job.id, "FAILING", issues.join("; ")];
    }

    return [job.id, "HEALTHY", `log updated ${formatMonthMinute(fs.statSync(job.log).mtime)}`];
  }

  const state = findOpenClawState(job.openclaw_id);
  if (state?.lastStatus === "ok") {
    return [job.id, "HEALTHY", "last run ok"];
  }
  if (state?.lastStatus === "error") {
    return [job.id, "FAILING", state.lastError || `${state.consecutiveErrors ?? 0} consecutive errors`];
  }
  return [job.id, "UNKNOWN", "no state data"];
}

function cmdHealth(args: string[]): void {
  let targetId = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--id") {
      targetId = args[index + 1] ?? die("Missing value for --id");
      index += 1;
      continue;
    }
    die(`Unknown option: ${arg}`);
  }

  const rows = registryJobs()
    .filter((job) => !targetId || job.id === targetId)
    .map((job) => healthRow(job));

  if (rows.length === 0) {
    console.log(targetId ? `Job not found: ${targetId}` : "No jobs in registry.");
    process.exit(1);
  }

  printTable(rows, ["ID", "STATUS", "DETAILS"]);

  const healthy = rows.filter((row) => row[1] === "HEALTHY").length;
  const failing = rows.filter((row) => row[1] === "FAILING").length;
  const disabled = rows.filter((row) => row[1] === "DISABLED").length;
  const unknown = rows.filter((row) => row[1] === "UNKNOWN").length;
  console.log(`\nSummary: ${healthy} healthy, ${failing} failing, ${disabled} disabled, ${unknown} unknown`);
}

function cmdDebug(jobId?: string): void {
  if (!jobId) {
    die("Usage: cron-cli debug <id>");
  }

  console.log(`===== DEBUG: ${jobId} =====`);
  console.log("");
  console.log("--- Registry Entry ---");
  cmdShow(jobId);
  console.log("");
  console.log("--- Health Check ---");
  cmdHealth(["--id", jobId]);
  console.log("");
  console.log("--- Recent Logs ---");
  try {
    cmdLogs(jobId, ["--lines", "20"]);
  } catch {
    console.log("(no logs available)");
  }
  console.log("");
  console.log("===== END DEBUG =====");
}

function cmdToggle(action: "enable" | "disable", jobId?: string): void {
  if (!jobId) {
    die(`Usage: cron-cli ${action} <id>`);
  }

  const newState = action === "enable";
  const registry = readRegistry();
  const job = (registry.jobs ?? []).find((entry) => entry.id === jobId);
  if (!job) {
    console.error(`Job not found: ${jobId}`);
    process.exit(1);
  }

  job.enabled = newState;
  writeRegistry(registry);
  console.log(`Registry updated: ${jobId} enabled=${newState}`);

  if (job.layer === "openclaw" && job.openclaw_id && fs.existsSync(JOBS_JSON)) {
    const jobsFile = readJobsJson();
    const openClawJob = (jobsFile.jobs ?? []).find((entry) => entry.id === job.openclaw_id);
    if (openClawJob) {
      openClawJob.enabled = newState;
      writeJobsJson(jobsFile);
      console.log(`jobs.json updated: ${job.openclaw_id} enabled=${newState}`);
    }
    return;
  }

  if (job.layer === "linux") {
    console.log(`NOTE: To ${action} a Linux crontab job, edit crontab manually: crontab -e`);
    console.log("(Comment/uncomment the relevant line)");
  }
}

function cmdTest(jobId?: string): void {
  if (!jobId) {
    die("Usage: cron-cli test <id>");
  }

  const job = getJob(jobId);
  if (!job) {
    die(`Job not found: ${jobId}`);
  }

  if (job.layer === "openclaw") {
    console.log("OpenClaw jobs cannot be test-run from the CLI.");
    console.log(`Use: openclaw cron run --id ${job.openclaw_id ?? ""}`);
    return;
  }

  console.log(`Running: ${job.command}`);
  console.log("---");

  const start = Date.now();
  const result = shell(job.command);
  const duration = Math.floor((Date.now() - start) / 1000);

  if (result.output) {
    console.log(result.output);
  }
  console.log("---");
  console.log(`Exit code: ${result.status}`);
  console.log(`Duration: ${duration}s`);

  const issues: string[] = [];
  if (job.expects?.exit_code !== undefined && result.status !== job.expects.exit_code) {
    issues.push(`Exit code ${result.status} != expected ${job.expects.exit_code}`);
  }
  if (job.expects?.log_contains && !result.output.includes(job.expects.log_contains)) {
    issues.push(`Output missing expected text: "${job.expects.log_contains}"`);
  }
  if (job.expects?.log_not_contains && result.output.includes(job.expects.log_not_contains)) {
    issues.push(`Output contains forbidden text: "${job.expects.log_not_contains}"`);
  }

  if (issues.length > 0) {
    console.log("RESULT: FAILING");
    for (const issue of issues) {
      console.log(`  - ${issue}`);
    }
    return;
  }

  console.log("RESULT: HEALTHY");
}

function cmdAdd(args: string[]): void {
  let id = "";
  let name = "";
  let schedule = "";
  let layer = "";
  let command = "";
  let category = "";
  let description = "";
  let log = "";
  let agent = "";
  let sessionTarget = "";
  let prompt = "";
  let thinking = "";
  let timeoutSecs = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];

    switch (arg) {
      case "--id":
        id = value ?? "";
        index += 1;
        break;
      case "--name":
        name = value ?? "";
        index += 1;
        break;
      case "--schedule":
        schedule = value ?? "";
        index += 1;
        break;
      case "--layer":
        layer = value ?? "";
        index += 1;
        break;
      case "--command":
        command = value ?? "";
        index += 1;
        break;
      case "--category":
        category = value ?? "";
        index += 1;
        break;
      case "--description":
        description = value ?? "";
        index += 1;
        break;
      case "--log":
        log = value ?? "";
        index += 1;
        break;
      case "--agent":
        agent = value ?? "";
        index += 1;
        break;
      case "--session-target":
        sessionTarget = value ?? "";
        index += 1;
        break;
      case "--prompt":
        prompt = value ?? "";
        index += 1;
        break;
      case "--thinking":
        thinking = value ?? "";
        index += 1;
        break;
      case "--timeout":
        timeoutSecs = value ?? "";
        index += 1;
        break;
      default:
        die(`Unknown option: ${arg}`);
    }
  }

  if (!id) die("--id is required");
  if (!name) die("--name is required");
  if (!schedule) die("--schedule is required");
  if (!layer) die("--layer is required (linux|openclaw)");

  if (layer === "linux") {
    if (!command) die("--command is required for linux jobs");
  } else if (layer === "openclaw") {
    if (!prompt) die("--prompt is required for openclaw jobs");
    if (!agent) {
      // Default to first native agent from config, falling back to "direct"
      try {
        const configPath = path.join(OPENCLAW_HOME, "openclaw.json");
        const raw = fs.readFileSync(configPath, "utf8");
        const config = JSON.parse(raw) as { agents?: { list?: Array<{ id?: string; runtime?: { type?: string } }> } };
        const native = (config.agents?.list ?? []).find((a) => {
          const rt = a.runtime?.type;
          return !rt || rt === "native";
        });
        agent = native?.id ? String(native.id) : "direct";
      } catch {
        agent = "direct";
      }
    }
    if (!sessionTarget) sessionTarget = "isolated";
    if (!thinking) thinking = "medium";
    if (!timeoutSecs) timeoutSecs = "900";
  }

  if (!category) category = "infrastructure";
  if (!log && layer === "linux") log = `/tmp/${id}.log`;

  const registry = readRegistry();
  registry.jobs ??= [];
  if (registry.jobs.some((job) => job.id === id)) {
    console.error(`Job already exists in registry: ${id}`);
    process.exit(1);
  }

  const registryJob: RegistryJob = {
    id,
    name,
    schedule,
    layer: layer as "linux" | "openclaw",
    enabled: true,
    category,
    description,
    command: layer === "linux" ? command : `${prompt.slice(0, 120)}...`,
    needs_ai: layer === "openclaw",
    ...(layer === "linux"
      ? { log, expects: { exit_code: 0, log_not_contains: "ERROR" } }
      : { openclaw_id: id }),
  };

  registry.jobs.push(registryJob);
  writeRegistry(registry);
  console.log(`Registry: added ${id}`);

  if (layer === "openclaw") {
    const jobsFile = readJobsJson();
    jobsFile.jobs ??= [];
    if ((jobsFile.jobs ?? []).some((job) => job.id === id)) {
      console.log(`jobs.json: ${id} already exists, skipping`);
      return;
    }

    const nowMs = Date.now();
    jobsFile.jobs.push({
      id,
      agentId: agent,
      name,
      enabled: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: {
        kind: "cron",
        expr: schedule,
        tz: "America/Chicago",
      },
      sessionTarget,
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: prompt,
        thinking,
        timeoutSeconds: Number(timeoutSecs),
      },
      state: {},
    });
    writeJobsJson(jobsFile);
    console.log(`jobs.json: added ${id} (agent=${agent}, session=${sessionTarget})`);
    console.log("");
    console.log("OpenClaw cron job created. It will fire on schedule via the gateway.");
    console.log(`To test now: openclaw agent --agent ${agent} --session-id test-${id} --message '${prompt.slice(0, 80)}...'`);
    return;
  }

  const cronLine = `${schedule} ${command} >>${log} 2>&1`;
  const currentCrontab = readCrontab();
  if (currentCrontab.includes(log)) {
    console.log(`Crontab: line for ${log} already exists, skipping`);
    return;
  }

  writeCrontab(`${currentCrontab}${currentCrontab.endsWith("\n") || currentCrontab.length === 0 ? "" : "\n"}${cronLine}\n`);
  console.log(`Crontab: added line writing to ${log}`);
}

function cmdEdit(jobId?: string, args: string[] = []): void {
  if (!jobId) {
    die("Usage: cron-cli edit <id> [--schedule ...] [--enabled true|false] [--description ...]");
  }

  let schedule = "";
  let enabled = "";
  let description = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--schedule") {
      schedule = value ?? "";
      index += 1;
      continue;
    }
    if (arg === "--enabled") {
      enabled = value ?? "";
      index += 1;
      continue;
    }
    if (arg === "--description") {
      description = value ?? "";
      index += 1;
      continue;
    }
    die(`Unknown option: ${arg}`);
  }

  const registry = readRegistry();
  const job = (registry.jobs ?? []).find((entry) => entry.id === jobId);
  if (!job) {
    console.error(`Job not found: ${jobId}`);
    process.exit(1);
  }

  if (schedule) job.schedule = schedule;
  if (enabled) job.enabled = enabled.toLowerCase() === "true";
  if (description) job.description = description;
  writeRegistry(registry);

  console.log(`Updated job: ${jobId}`);
  const changes: string[] = [];
  if (schedule) changes.push(`schedule=${schedule}`);
  if (enabled) changes.push(`enabled=${enabled}`);
  if (description) changes.push("description updated");
  console.log(`  Changes: ${changes.join(", ")}`);
}

function cmdDelete(jobId?: string): void {
  if (!jobId) {
    die("Usage: cron-cli delete <id>");
  }

  const job = getJob(jobId);
  if (!job) {
    die(`Job not found in registry: ${jobId}`);
  }

  console.log(`Deleting job: ${jobId} (layer: ${job.layer})`);

  const registry = readRegistry();
  const originalCount = registry.jobs?.length ?? 0;
  registry.jobs = (registry.jobs ?? []).filter((entry) => entry.id !== jobId);
  if ((registry.jobs?.length ?? 0) === originalCount) {
    console.error(`Job not found in registry: ${jobId}`);
    process.exit(1);
  }
  writeRegistry(registry);
  console.log(`  Registry: removed ${jobId}`);

  if (job.layer === "openclaw" && job.openclaw_id) {
    const jobsFile = readJobsJson();
    const before = jobsFile.jobs?.length ?? 0;
    jobsFile.jobs = (jobsFile.jobs ?? []).filter((entry) => entry.id !== job.openclaw_id);
    writeJobsJson(jobsFile);
    if ((jobsFile.jobs?.length ?? 0) !== before) {
      console.log(`  jobs.json: removed ${job.openclaw_id}`);
    } else {
      console.log(`  jobs.json: ${job.openclaw_id} not found (already removed or ID mismatch)`);
    }
  }

  if (job.layer === "linux") {
    if (!job.log) {
      console.log("  Crontab: no log path in registry — cannot safely identify crontab line. Remove manually: crontab -e");
    } else {
      const currentCrontab = readCrontab();
      if (currentCrontab.includes(job.log)) {
        const filtered = currentCrontab
          .split("\n")
          .filter((line) => !line.includes(job.log!))
          .join("\n");
        writeCrontab(`${filtered.trimEnd()}\n`);
        console.log(`  Crontab: removed line writing to ${job.log}`);
      } else {
        console.log(`  Crontab: no line writing to ${job.log} (already removed)`);
      }
    }
  }

  console.log("Done.");
}

function usage(): void {
  console.log(`cron-cli — Unified cron management for OpenClaw

Commands:
  add          Create a new job (linux or openclaw)
  list         Show all jobs with health status
  show <id>    Full details + last runs + health check
  edit <id>    Change schedule, description, or enabled state
  delete <id>  Remove from registry, jobs.json, and crontab
  enable <id>  Enable a job
  disable <id> Disable a job
  health       Health check all jobs (or --id <id> for one)
  debug <id>   Diagnostic dump: config + health + logs
  logs <id>    Tail the log (--lines N, default 30)
  test <id>    Run a linux job now and check output

Add (linux):
  cron-cli add --id <id> --name "..." --schedule "..." --layer linux \\
    --command "..." [--category ...] [--description "..."] [--log ...]

Add (openclaw):
  cron-cli add --id <id> --name "..." --schedule "..." --layer openclaw \\
    --prompt "..." [--agent direct] [--session-target isolated] \\
    [--thinking medium] [--timeout 900] [--category ...] [--description "..."]

List filters:
  cron-cli list [--layer linux|openclaw] [--category <cat>] [--status healthy|failing|disabled]

Categories: data-sync, memory-pipeline, agent-task, infrastructure

Examples:
  cron-cli add --id my-job --name "My Job" --schedule "0 9 * * *" --layer openclaw --prompt "Do the thing"
  cron-cli list --status failing
  cron-cli debug granola-sync
  cron-cli delete old-job`);
}

function formatDateTime(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hour = String(value.getHours()).padStart(2, "0");
  const minute = String(value.getMinutes()).padStart(2, "0");
  const second = String(value.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function formatMonthMinute(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hour = String(value.getHours()).padStart(2, "0");
  const minute = String(value.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function main(argv: string[]): void {
  requireRegistry();

  const [command, ...args] = argv;
  switch (command) {
    case "list":
      cmdList(args);
      return;
    case "show":
      cmdShow(args[0]);
      return;
    case "logs":
      cmdLogs(args[0], args.slice(1));
      return;
    case "health":
      cmdHealth(args);
      return;
    case "debug":
      cmdDebug(args[0]);
      return;
    case "enable":
      cmdToggle("enable", args[0]);
      return;
    case "disable":
      cmdToggle("disable", args[0]);
      return;
    case "test":
      cmdTest(args[0]);
      return;
    case "add":
      cmdAdd(args);
      return;
    case "edit":
      cmdEdit(args[0], args.slice(1));
      return;
    case "delete":
      cmdDelete(args[0]);
      return;
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
    default:
      usage();
      process.exit(1);
  }
}

main(process.argv.slice(2));
