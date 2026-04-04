import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { db, stmts, type DashboardStatements } from "./db.js";
import { env } from "./env.js";
import { parseSessionKey } from "./event-ingester.js";

/**
 * Inspect a tool result payload to determine if it represents an application-level error.
 * Returns true if the result looks successful, false if it contains error signals.
 */
function detectToolResultSuccess(output: string): boolean {
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object") {
      if (parsed.status === "error") return false;
      if (parsed.error && !parsed.result) return false;
    }
  } catch {
    // Not JSON — not an error pattern we can detect structurally
  }
  return true;
}

/**
 * Ingests session JSONL files into SQLite.
 *
 * Two modes:
 * 1. Backfill: scan all existing JSONL files and import everything
 * 2. Watch: monitor session directories for new writes and ingest incrementally
 *
 * The JSONL files are the authoritative record — they contain:
 * - User messages (with full text)
 * - Assistant messages (with full text, token usage, model, cost)
 * - Tool calls (name, arguments)
 * - Tool results (full output including memory_search scores/snippets)
 * - Session metadata (model-snapshot)
 */

type SessionEntry = {
  type: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  customType?: string;
  data?: Record<string, unknown>;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    provider?: string;
    model?: string;
    api?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: {
        total?: number;
      };
    };
    stopReason?: string;
    timestamp?: number;
  };
};

type IngestOptions = {
  logProgress?: boolean;
};

const fileOffsets = new Map<string, number>();

/**
 * Optional callback invoked for each newly ingested entry so the live feed
 * can broadcast user messages and tool calls that the gateway WS doesn't emit.
 */
export type LiveEntryCallback = (entry: {
  kind: "user" | "assistant" | "tool_call" | "tool_result";
  entryId?: string;
  agentId: string;
  sessionKey: string;
  channel: string;
  text: string;
  sender?: string;
  toolName?: string;
  timestamp: string;
}) => void;

let liveCallback: LiveEntryCallback | null = null;

export function setLiveEntryCallback(cb: LiveEntryCallback | null): void {
  liveCallback = cb;
}

/**
 * Strip OpenClaw's metadata wrapper from user messages.
 * Messages from Telegram/Slack arrive wrapped in:
 *   Conversation info (untrusted metadata): ```json {...} ```
 *   Sender (untrusted metadata): ```json {...} ```
 *   <actual message>
 *
 * Returns { text, sender, channel } with the real content extracted.
 */
function unwrapUserMessage(raw: string): { text: string; sender?: string; channel?: string } {
  // Fast path: no metadata wrapper
  if (!raw.includes("(untrusted metadata)")) {
    return { text: raw };
  }

  let sender: string | undefined;
  let channel: string | undefined;

  // Extract sender name from the Sender metadata block
  const senderMatch = raw.match(/"name"\s*:\s*"([^"]+)"/);
  if (senderMatch) sender = senderMatch[1];

  // Extract channel from conversation_label
  const labelMatch = raw.match(/"conversation_label"\s*:\s*"([^"]+)"/);
  if (labelMatch) {
    const label = labelMatch[1];
    if (label.toLowerCase().includes("telegram") || label.includes("topic:")) channel = "telegram";
    else if (label.toLowerCase().includes("slack")) channel = "slack";
  }

  // Strip all metadata blocks: everything from "Conversation info" or "Sender" through the closing ```
  const stripped = raw
    .replace(/(?:Conversation info|Sender)\s*\(untrusted metadata\):\s*```json\s*\{[^`]*\}\s*```/gs, "")
    .trim();

  return { text: stripped || raw, sender, channel };
}

function pruneFileOffsets(): void {
  for (const filePath of fileOffsets.keys()) {
    if (!fs.existsSync(filePath)) {
      fileOffsets.delete(filePath);
    }
  }
}

// Lazy batch insert — db may not be initialized at import time
function insertBatch(entries: Array<() => void>): void {
  const txn = db.transaction((fns: Array<() => void>) => {
    for (const fn of fns) fn();
  });
  txn(entries);
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (typeof part === "object" && part !== null) {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        parts.push(p.text);
      }
    }
  }
  return parts.join("\n");
}

function extractToolCalls(content: unknown): Array<{ id: string; name: string; arguments: unknown }> {
  if (!Array.isArray(content)) return [];
  const calls: Array<{ id: string; name: string; arguments: unknown }> = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null) {
      const p = part as Record<string, unknown>;
      if (p.type === "toolCall" || p.type === "tool_use") {
        calls.push({
          id: (p.id as string) || "",
          name: (p.name as string) || "",
          arguments: p.arguments || p.input || {},
        });
      }
    }
  }
  return calls;
}

function logIngestProgress(filePath: string, processedLines: number, processedBytes: number, totalBytes: number): void {
  const percent = totalBytes > 0 ? ((processedBytes / totalBytes) * 100).toFixed(1) : "0.0";
  console.log(
    `[session-ingester] ${path.basename(filePath)} ${percent}% (${processedLines.toLocaleString()} lines, ${processedBytes}/${totalBytes} bytes)`
  );
}

function resolveSessionKeyFromFile(filePath: string): { sessionKey: string; agentId: string } | null {
  // Path: ~/.openclaw/agents/<agentId>/sessions/<file>.jsonl
  const parts = filePath.split(path.sep);
  const agentsIdx = parts.indexOf("agents");
  if (agentsIdx === -1 || agentsIdx + 1 >= parts.length) return null;

  const agentId = parts[agentsIdx + 1];

  // Look up session key from sessions.json
  const sessionsJsonPath = path.join(
    ...parts.slice(0, agentsIdx + 2),
    "sessions",
    "sessions.json"
  );

  // Use absolute path
  const absSessionsJson = filePath.startsWith("/")
    ? path.join(path.dirname(filePath), "sessions.json")
    : sessionsJsonPath;

  try {
    const index = JSON.parse(fs.readFileSync(absSessionsJson, "utf8"));
    const fileSessionId = path.basename(filePath, ".jsonl");
    for (const [key, entry] of Object.entries(index)) {
      const e = entry as { sessionFile?: string; sessionId?: string };
      // Match on sessionFile path (main sessions, telegram, etc.)
      if (e.sessionFile === filePath || filePath.endsWith(path.basename(e.sessionFile || ""))) {
        return { sessionKey: key, agentId };
      }
      // Match on sessionId — JSONL filename IS the sessionId (for cron/isolated sessions where sessionFile is null)
      if (e.sessionId && e.sessionId === fileSessionId) {
        return { sessionKey: key, agentId };
      }
    }
  } catch {
    // sessions.json not found or unparseable
  }

  // Fallback: construct from agent ID
  return { sessionKey: `agent:${agentId}:unknown`, agentId };
}

export async function ingestSessionFile(
  filePath: string,
  sessionKey: string,
  agentId: string,
  options: IngestOptions = {}
): Promise<number> {
  const info = parseSessionKey(sessionKey);
  let ingested = 0;
  const previousOffset = fileOffsets.get(filePath) || 0;
  let processedLines = 0;
  let processedBytes = 0;
  let nextProgressLogAtLine = 1000;
  let nextProgressLogAtByte = 1024 * 1024;

  // Track the byte offset we've already read
  const stat = fs.statSync(filePath);
  if (stat.size < previousOffset) {
    fileOffsets.set(filePath, 0);
  } else if (stat.size === previousOffset) {
    return 0;
  }
  const readOffset = fileOffsets.get(filePath) || 0;
  nextProgressLogAtByte = readOffset + 1024 * 1024;

  const stream = fs.createReadStream(filePath, {
    encoding: "utf8",
    start: readOffset,
  });
  const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  // Ensure session exists
  try {
    stmts.upsertSession.run({
      session_key: sessionKey,
      agent_id: info.agentId || agentId,
      channel: info.channel,
      channel_name: info.channelName,
      source: info.source,
      runtime_type: info.runtimeType,
    });
  } catch {
    // Already exists
  }

  const batch: Array<() => void> = [];

  for await (const line of lineReader) {
    if (!line.trim()) continue;
    processedLines += 1;
    processedBytes += Buffer.byteLength(line, "utf8") + 1;

    if (
      options.logProgress &&
      (processedLines >= nextProgressLogAtLine || readOffset + processedBytes >= nextProgressLogAtByte)
    ) {
      logIngestProgress(filePath, processedLines, readOffset + processedBytes, stat.size);
      nextProgressLogAtLine += 1000;
      nextProgressLogAtByte += 1024 * 1024;
    }

    let entry: SessionEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = entry.timestamp || new Date().toISOString();

    if (entry.type === "custom" && entry.customType === "model-snapshot" && entry.data) {
      continue;
    }

    if (entry.type !== "message" || !entry.message) continue;

    const msg = entry.message;
    const role = msg.role;
    if (!role) continue;

    if (role === "user") {
      const text = extractTextContent(msg.content);
      batch.push(() => {
        const result = stmts.insertMessage.run({
          entry_id: entry.id || null,
          run_id: null,
          session_key: sessionKey,
          agent_id: info.agentId || agentId,
          role: "user",
          content: text,
          channel: info.channel,
          channel_name: info.channelName,
          source: info.source,
          tokens: msg.usage?.input || null,
          cost_total: null,
          timestamp: ts,
        });
        if (result.changes > 0) {
          stmts.incrementSessionMetrics.run({
            session_key: sessionKey,
            message_increment: 1,
            token_increment: msg.usage?.input || 0,
          });
          ingested++;
          const unwrapped = unwrapUserMessage(text);
          liveCallback?.({
            kind: "user",
            entryId: entry.id || undefined,
            agentId: info.agentId || agentId,
            sessionKey,
            channel: unwrapped.channel || info.channel,
            text: unwrapped.text.slice(0, 300),
            sender: unwrapped.sender,
            timestamp: ts,
          });
        }
      });
    } else if (role === "assistant") {
      const text = extractTextContent(msg.content);
      const toolCalls = extractToolCalls(msg.content);

      // Save assistant message
      if (text.trim()) {
        batch.push(() => {
          const result = stmts.insertMessage.run({
            entry_id: entry.id || null,
            run_id: null,
            session_key: sessionKey,
            agent_id: info.agentId || agentId,
            role: "assistant",
            content: text,
            channel: info.channel,
            channel_name: info.channelName,
            source: info.source,
            tokens: msg.usage?.totalTokens || null,
            cost_total: msg.usage?.cost?.total || null,
            timestamp: ts,
          });
          if (result.changes > 0) {
            stmts.incrementSessionMetrics.run({
              session_key: sessionKey,
              message_increment: 1,
              token_increment: msg.usage?.totalTokens || 0,
            });
            ingested++;
            liveCallback?.({
              kind: "assistant",
              entryId: entry.id || undefined,
              agentId: info.agentId || agentId,
              sessionKey,
              channel: info.channel,
              text: text.slice(0, 300),
              timestamp: ts,
            });
          }
        });
      }

      // Save tool calls
      for (const tc of toolCalls) {
        batch.push(() => {
          const result = stmts.insertToolCall.run({
            tool_call_id: tc.id || null,
            run_id: null,
            session_key: sessionKey,
            agent_id: info.agentId || agentId,
            tool_name: tc.name,
            input: JSON.stringify(tc.arguments),
            output: null, // Will be filled by toolResult
            channel: info.channel,
            source: info.source,
            duration_ms: null,
            success: null,
            timestamp: ts,
          });
          if (result.changes > 0) {
            ingested++;
            const args = tc.arguments as Record<string, unknown>;
            const inputPreview = (args.command ?? args.file_path ?? args.pattern ?? args.query ?? args.prompt ?? args.content) as string | undefined;
            liveCallback?.({
              kind: "tool_call",
              entryId: entry.id || undefined,
              agentId: info.agentId || agentId,
              sessionKey,
              channel: info.channel,
              text: inputPreview ? String(inputPreview).slice(0, 200) : "",
              toolName: tc.name,
              timestamp: ts,
            });
          }
        });

        // Check for skill trigger
        const args = tc.arguments as Record<string, unknown>;
        const filePath = (args.file_path || args.path || "") as string;
        const skillMatch = filePath.match(/skills\/([^/]+)\/SKILL\.md/);
        if (skillMatch) {
          batch.push(() => {
            stmts.insertSkillTrigger.run({
              skill_name: skillMatch[1],
              agent_id: info.agentId || agentId,
              session_key: sessionKey,
              channel: info.channel,
              channel_name: info.channelName,
              source: info.source,
              timestamp: ts,
            });
          });
        }
      }
    } else if (role === "toolResult") {
      const text = extractTextContent(msg.content);
      const toolName = msg.toolName || "unknown";

      // Save as a message so we can see what tools returned
      batch.push(() => {
        const result = stmts.insertMessage.run({
          entry_id: entry.id || null,
          run_id: null,
          session_key: sessionKey,
          agent_id: info.agentId || agentId,
          role: "toolResult",
          content: text.slice(0, 10000), // Cap tool results to avoid huge blobs
          channel: info.channel,
          channel_name: info.channelName,
          source: info.source,
          tokens: null,
          cost_total: null,
          timestamp: ts,
        });
        if (result.changes > 0) {
          stmts.incrementSessionMetrics.run({
            session_key: sessionKey,
            message_increment: 1,
            token_increment: 0,
          });
          ingested++;
          liveCallback?.({
            kind: "tool_result",
            entryId: entry.id || undefined,
            agentId: info.agentId || agentId,
            sessionKey,
            channel: info.channel,
            text: text.slice(0, 150),
            toolName,
            timestamp: ts,
          });
        }
      });

      // Try to update the matching tool_call with the result
      if (msg.toolCallId) {
        const outputText = text.slice(0, 5000);
        const success = detectToolResultSuccess(outputText) ? 1 : 0;
        batch.push(() => {
          stmts.updateToolCallResult.run({
            output: outputText,
            success,
            session_key: sessionKey,
            tool_call_id: msg.toolCallId,
          });
        });
      }
    }
  }

  // Execute batch
  if (batch.length > 0) {
    insertBatch(batch);

    // Backfill run_id on newly inserted messages and tool_calls by correlating
    // with agent_runs timestamps. This links JSONL-sourced rows to WebSocket-sourced runs.
    try {
      stmts.backfillRunIdMessages.run({ session_key: sessionKey });
      stmts.backfillRunIdToolCalls.run({ session_key: sessionKey });
    } catch {
      // Backfill is best-effort — agent_runs may not have the run yet if WS is behind
    }
  }

  if (options.logProgress && processedLines >= 1000) {
    logIngestProgress(filePath, processedLines, stat.size, stat.size);
  }

  // Update offset
  fileOffsets.set(filePath, stat.size);

  return ingested;
}

/**
 * Backfill: scan all existing session JSONL files and ingest them.
 */
export async function backfillSessions(): Promise<{ files: number; entries: number }> {
  // TODO: Startup backfill still walks every indexed JSONL file serially. Move
  // this onto a resumable background job if startup latency becomes noticeable.
  const agentsDir = path.join(env.openclawHome, "agents");
  let totalFiles = 0;
  let totalEntries = 0;

  pruneFileOffsets();

  let agentDirs: string[];
  try {
    agentDirs = fs.readdirSync(agentsDir).filter((name) => {
      const full = path.join(agentsDir, name);
      return fs.statSync(full).isDirectory() && !name.startsWith("_");
    });
  } catch {
    console.error("Could not read agents directory:", agentsDir);
    return { files: 0, entries: 0 };
  }

  for (const agentId of agentDirs) {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
    const sessionsJsonPath = path.join(sessionsDir, "sessions.json");

    if (!fs.existsSync(sessionsJsonPath)) continue;

    let index: Record<string, { sessionFile?: string; sessionId?: string }>;
    try {
      index = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf8"));
    } catch {
      continue;
    }

    for (const [sessionKey, entry] of Object.entries(index)) {
      // Resolve the JSONL file path: use sessionFile if available, otherwise derive from sessionId
      let filePath = entry.sessionFile;
      if (!filePath && entry.sessionId) {
        const candidate = path.join(sessionsDir, `${entry.sessionId}.jsonl`);
        if (fs.existsSync(candidate)) filePath = candidate;
      }
      if (!filePath || !fs.existsSync(filePath)) continue;

      try {
        const count = await ingestSessionFile(filePath, sessionKey, agentId, { logProgress: true });
        if (count > 0) {
          totalFiles++;
          totalEntries += count;
        }
      } catch (err) {
        console.error(`Error ingesting ${filePath}:`, err);
      }
    }
  }

  return { files: totalFiles, entries: totalEntries };
}

/**
 * Watch session directories for new JSONL writes and ingest incrementally.
 */
export function watchSessions(): void {
  const agentsDir = path.join(env.openclawHome, "agents");
  pruneFileOffsets();

  // Debounce per file
  const debounceTimers = new Map<string, NodeJS.Timeout>();

  function handleFileChange(filePath: string) {
    if (!filePath.endsWith(".jsonl")) return;

    // Debounce: wait 2 seconds after last write
    const existing = debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    debounceTimers.set(
      filePath,
      setTimeout(async () => {
        debounceTimers.delete(filePath);
        const resolved = resolveSessionKeyFromFile(filePath);
        if (!resolved) return;

        try {
          const count = await ingestSessionFile(filePath, resolved.sessionKey, resolved.agentId);
          if (count > 0) {
            console.log(`[session-ingester] Ingested ${count} entries from ${path.basename(filePath)}`);
          }
        } catch (err) {
          console.error(`[session-ingester] Error ingesting ${filePath}:`, err);
        }
      }, 2000)
    );
  }

  // Watch each agent's sessions directory
  let agentDirs: string[];
  try {
    agentDirs = fs.readdirSync(agentsDir).filter((name) => {
      const full = path.join(agentsDir, name);
      return fs.statSync(full).isDirectory() && !name.startsWith("_");
    });
  } catch {
    console.error("[session-ingester] Could not read agents directory");
    return;
  }

  for (const agentId of agentDirs) {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;

    try {
      fs.watch(sessionsDir, { persistent: false }, (_eventType, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) return;
        handleFileChange(path.join(sessionsDir, filename));
      });
      console.log(`[session-ingester] Watching ${agentId}/sessions/`);
    } catch (err) {
      console.error(`[session-ingester] Could not watch ${sessionsDir}:`, err);
    }
  }
}

/**
 * Start the session ingester: backfill existing data, then watch for new.
 */
export async function startSessionIngester(): Promise<void> {
  console.log("[session-ingester] Starting backfill...");
  const result = await backfillSessions();
  console.log(`[session-ingester] Backfill complete: ${result.files} files, ${result.entries} entries`);

  watchSessions();
  console.log("[session-ingester] Watching for new session data");
}
