import { stmts } from "./db.js";

/**
 * Inspect a tool result object to detect application-level errors.
 * Returns false if the result indicates an error, true otherwise.
 */
function isToolResultSuccess(result: unknown): boolean {
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (obj.status === "error") return false;
    if (obj.error && !obj.result) return false;
  }
  return true;
}

/**
 * Parses a gateway WebSocket event and writes structured data to SQLite.
 *
 * Source tracking:
 * - "telegram", "slack", "webchat" — from channel in sessionKey
 * - "cron", "hook" — from sessionKey prefix
 * - "acp" — from runtime type in agent config
 * - channel_name — human-readable label (e.g. "telegram:group:Chungbot:topic:1")
 */

type GatewayEvent = {
  type?: string;
  event?: string;
  payload?: {
    runId?: string;
    sessionKey?: string;
    stream?: string;
    data?: {
      phase?: string;
      text?: string;
      delta?: string;
      startedAt?: number;
      endedAt?: number;
      toolName?: string;
      toolInput?: unknown;
      toolResult?: unknown;
      durationMs?: number;
      success?: boolean;
      model?: string;
    };
    seq?: number;
    ts?: number;
  };
  seq?: number;
};

export function parseSessionKey(sessionKey: string): {
  agentId: string;
  channel: string;
  channelName: string;
  source: string;
  runtimeType: string;
} {
  // Format: agent:<agentId>:<rest>
  // Examples:
  //   agent:direct:main
  //   agent:direct:telegram:group:-1003691004254:topic:1
  //   agent:direct:webchat:abc123
  //   agent:acp-claude:binding:telegram:-1003691004254:topic:4
  //   cron:jobname:isolated
  //   hook:github:repo:issue:123

  const parts = sessionKey.split(":");

  let agentId = "unknown";
  let channel = "unknown";
  let channelName = sessionKey;
  let source = "unknown";
  let runtimeType = "native";

  if (parts[0] === "agent" && parts.length >= 3) {
    agentId = parts[1];

    // Detect ACP agents
    if (agentId.startsWith("acp-")) {
      runtimeType = "acp";
    }

    const rest = parts.slice(2);

    if (rest[0] === "main") {
      channel = "main";
      source = "control-ui";
      channelName = "Main Session";
    } else if (rest[0] === "telegram") {
      channel = "telegram";
      source = "telegram";
      // Build readable name from group/topic info
      const groupId = rest[2] || "";
      const topicId = rest[4] || "";
      channelName = topicId ? `telegram:group:${groupId}:topic:${topicId}` : `telegram:${rest[1] || "dm"}:${groupId}`;
    } else if (rest[0] === "webchat") {
      channel = "webchat";
      source = "control-ui";
      channelName = `webchat:${rest[1] || "session"}`;
    } else if (rest[0] === "slack") {
      channel = "slack";
      source = "slack";
      channelName = `slack:${rest.slice(1).join(":")}`;
    } else if (rest[0] === "binding") {
      // ACP binding: agent:acp-claude:binding:telegram:...
      channel = rest[1] || "binding";
      source = rest[1] || "binding";
      channelName = `${agentId}:${rest.slice(1).join(":")}`;
    } else {
      channel = rest[0] || "unknown";
      source = rest[0] || "unknown";
      channelName = rest.join(":");
    }
  } else if (parts[0] === "cron") {
    agentId = "cron";
    channel = "cron";
    source = "cron";
    channelName = `cron:${parts.slice(1).join(":")}`;
  } else if (parts[0] === "hook") {
    agentId = "hook";
    channel = "hook";
    source = `hook:${parts[1] || "unknown"}`;
    channelName = parts.join(":");
  }

  return { agentId, channel, channelName, source, runtimeType };
}

// Track active runs for assembling final text
const activeRuns = new Map<
  string,
  { text: string; sessionKey: string; agentId: string; channel: string; channelName: string; source: string; startedAt: number }
>();

export function ingestGatewayEvent(raw: string): void {
  let parsed: GatewayEvent;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  if (parsed.type !== "event" || !parsed.event) return;

  const payload = parsed.payload;
  if (!payload) return;

  const sessionKey = payload.sessionKey || null;
  const runId = payload.runId || null;
  const ts = payload.ts ? new Date(payload.ts).toISOString() : new Date().toISOString();

  // Parse source info from session key
  const info = sessionKey ? parseSessionKey(sessionKey) : {
    agentId: "unknown",
    channel: "unknown",
    channelName: "",
    source: "unknown",
    runtimeType: "native",
  };

  // Always log to events table (raw)
  try {
    stmts.insertEvent.run({
      type: parsed.type,
      event: parsed.event,
      agent_id: info.agentId,
      run_id: runId,
      session_key: sessionKey,
      channel: info.channel,
      channel_name: info.channelName,
      source: info.source,
      payload: raw,
      timestamp: ts,
    });
  } catch {
    // Ignore insert errors (e.g. during heavy load)
  }

  // Handle cron events — extract delivery status and summary
  if (parsed.event === "cron") {
    const p = payload as Record<string, unknown>;
    if (p.jobId) {
      const usage = p.usage as Record<string, number> | undefined;
      try {
        stmts.insertCronDelivery.run({
          job_id: p.jobId as string,
          run_id: runId,
          session_key: sessionKey,
          session_id: (p.sessionId as string) || null,
          status: (p.status as string) || "unknown",
          delivery_status: (p.deliveryStatus as string) || null,
          summary: (p.summary as string) || null,
          duration_ms: (p.durationMs as number) || null,
          model: (p.model as string) || null,
          provider: (p.provider as string) || null,
          input_tokens: usage?.input_tokens || null,
          output_tokens: usage?.output_tokens || null,
          total_tokens: usage?.total_tokens || null,
          timestamp: ts,
        });
      } catch {
        // Ignore insert errors
      }
    }
    return;
  }

  // Skip non-agent events for structured tables
  if (parsed.event !== "agent") return;

  const stream = payload.stream;
  const data = payload.data;
  if (!stream || !data || !sessionKey || !runId) return;

  // Ensure session exists
  try {
    stmts.upsertSession.run({
      session_key: sessionKey,
      agent_id: info.agentId,
      channel: info.channel,
      channel_name: info.channelName,
      source: info.source,
      runtime_type: info.runtimeType,
    });
  } catch {
    // Session already exists, that's fine
  }

  if (stream === "lifecycle") {
    if (data.phase === "start" && data.startedAt) {
      // New agent run
      activeRuns.set(runId, {
        text: "",
        sessionKey,
        agentId: info.agentId,
        channel: info.channel,
        channelName: info.channelName,
        source: info.source,
        startedAt: data.startedAt,
      });

      try {
        stmts.insertRun.run({
          run_id: runId,
          session_key: sessionKey,
          agent_id: info.agentId,
          channel: info.channel,
          channel_name: info.channelName,
          source: info.source,
          model: data.model || null,
          started_at: new Date(data.startedAt).toISOString(),
        });
      } catch {
        // Duplicate run_id, ignore
      }
    } else if (data.phase === "end" && data.endedAt) {
      const run = activeRuns.get(runId);
      const durationMs = run ? data.endedAt - run.startedAt : null;

      try {
        stmts.endRun.run({
          run_id: runId,
          ended_at: new Date(data.endedAt).toISOString(),
          duration_ms: durationMs,
        });
      } catch {
        // Run might not exist
      }

      // JSONL transcript ingestion is the authoritative source for message rows
      // and session metrics. Keeping WS ingestion to runs/tools/events avoids
      // double-counting the same assistant output once the session file lands.
      activeRuns.delete(runId);
    }
  } else if (stream === "assistant") {
    // Accumulate text deltas
    const run = activeRuns.get(runId);
    if (run && data.text) {
      run.text = data.text; // data.text is cumulative, not delta
    }
  } else if (stream === "tool") {
    // Tool call content is ingested from JSONL (authoritative source).
    // WebSocket tool events are only used for skill trigger detection.
    if (data.toolName) {
      const toolInput = data.toolInput as { file_path?: string; path?: string } | undefined;
      const filePath = toolInput?.file_path || toolInput?.path || "";
      const skillMatch = filePath.match(/skills\/([^/]+)\/SKILL\.md/);
      if (skillMatch) {
        try {
          stmts.insertSkillTrigger.run({
            skill_name: skillMatch[1],
            agent_id: info.agentId,
            session_key: sessionKey,
            channel: info.channel,
            channel_name: info.channelName,
            source: info.source,
            timestamp: ts,
          });
        } catch {
          // Ignore
        }
      }
    }
  }
}

// Clean old events periodically (every hour)
setInterval(() => {
  try {
    stmts.cleanOldEvents.run();
  } catch {
    // Ignore cleanup errors
  }
}, 60 * 60 * 1000);

// Drop abandoned runs so malformed or partial gateway streams do not leak memory.
setInterval(() => {
  const staleBefore = Date.now() - 60 * 60 * 1000;
  for (const [runId, run] of activeRuns.entries()) {
    if (run.startedAt < staleBefore) {
      activeRuns.delete(runId);
    }
  }
}, 10 * 60 * 1000);
