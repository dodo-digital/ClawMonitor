import { useState, useEffect, useRef, useCallback } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { StatusDot } from "@/components/ui/badge";
import { formatTime } from "@/lib/utils";
import {
  Pause,
  Play,
  Trash2,
  User,
  Bot,
  Terminal,
  CheckCircle,
  XCircle,
  Zap,
  Heart,
  Radio,
  ChevronRight,
  ChevronDown,
  Filter,
} from "lucide-react";

type LiveEvent = {
  id: string;
  type: string;
  event?: string;
  stream?: string;
  entryId?: string;
  agent_id?: string;
  channel?: string;
  channel_name?: string;
  source?: string;
  payload: string;
  timestamp: string;
  parsed: ParsedEvent;
};

type ParsedEvent =
  | { kind: "user_text"; text: string; sender?: string }
  | { kind: "assistant_text"; text: string; final: boolean }
  | { kind: "tool_call"; toolName: string; input?: string }
  | { kind: "tool_result"; toolName: string; success?: boolean; durationMs?: number; output?: string }
  | { kind: "lifecycle"; phase: "start" | "end"; model?: string; durationMs?: number }
  | { kind: "health"; ok: boolean; durationMs?: number }
  | { kind: "tick" }
  | { kind: "heartbeat"; preview?: string }
  | { kind: "gateway_status"; status: string }
  | { kind: "unknown"; summary: string };

function parseGatewayEvent(data: Record<string, unknown>): { parsed: ParsedEvent; stream?: string; channelOverride?: string } {
  if (data.type === "gateway_status") {
    return { parsed: { kind: "gateway_status", status: String(data.status ?? "unknown") } };
  }

  const event = data.event as string | undefined;
  const payload = data.payload as Record<string, unknown> | undefined;

  if (event === "tick") return { parsed: { kind: "tick" } };
  if (event === "heartbeat") {
    const preview = (payload?.preview as string) ?? undefined;
    return { parsed: { kind: "heartbeat", preview } };
  }

  if (event === "session" && payload) {
    const stream = payload.stream as string | undefined;
    const eventData = payload.data as Record<string, unknown> | undefined;
    const text = (eventData?.text as string) ?? "";

    if (stream === "user") {
      const sender = (eventData?.sender as string) ?? undefined;
      const realChannel = (eventData?.channel as string) ?? undefined;
      return { parsed: { kind: "user_text", text, sender }, stream: "user", channelOverride: realChannel };
    }
    if (stream === "tool_call") {
      return { parsed: { kind: "tool_call", toolName: (eventData?.toolName as string) ?? "unknown", input: text || undefined }, stream: "tool" };
    }
    if (stream === "tool_result") {
      return { parsed: { kind: "tool_result", toolName: (eventData?.toolName as string) ?? "unknown", output: text || undefined }, stream: "tool" };
    }
    if (stream === "assistant") {
      return { parsed: { kind: "assistant_text", text, final: true }, stream: "assistant" };
    }
  }

  if (event === "health") {
    const ok = (payload?.ok as boolean) ?? false;
    const durationMs = payload?.durationMs as number | undefined;
    return { parsed: { kind: "health", ok, durationMs } };
  }

  if (event === "agent" && payload) {
    const stream = payload.stream as string | undefined;
    const eventData = payload.data as Record<string, unknown> | undefined;

    if (stream === "assistant") {
      const text = (eventData?.text as string) ?? (eventData?.delta as string) ?? "";
      return { parsed: { kind: "assistant_text", text, final: !eventData?.delta }, stream };
    }

    if (stream === "tool") {
      const toolName = (eventData?.toolName as string) ?? "unknown";
      if (eventData?.toolResult !== undefined || eventData?.success !== undefined) {
        return {
          parsed: {
            kind: "tool_result",
            toolName,
            success: eventData?.success as boolean | undefined,
            durationMs: eventData?.durationMs as number | undefined,
          },
          stream,
        };
      }
      const input = eventData?.toolInput;
      let inputPreview: string | undefined;
      if (input && typeof input === "object") {
        const inp = input as Record<string, unknown>;
        inputPreview = (inp.command ?? inp.file_path ?? inp.pattern ?? inp.query ?? inp.prompt) as string | undefined;
        if (!inputPreview && inp.content && typeof inp.content === "string") {
          inputPreview = inp.content.slice(0, 80);
        }
      }
      return { parsed: { kind: "tool_call", toolName, input: inputPreview }, stream };
    }

    if (stream === "lifecycle") {
      const phase = (eventData?.phase as string) === "end" ? "end" : "start";
      const model = eventData?.model as string | undefined;
      let durationMs: number | undefined;
      if (phase === "end" && eventData?.endedAt && eventData?.startedAt) {
        durationMs = (eventData.endedAt as number) - (eventData.startedAt as number);
      }
      return { parsed: { kind: "lifecycle", phase, model, durationMs }, stream };
    }
  }

  let summary = event ?? data.type ?? "unknown";
  if (typeof summary !== "string") summary = "unknown";
  return { parsed: { kind: "unknown", summary: String(summary) } };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

type FilterMode = "all" | "no-noise" | "agent-only";

const FILTER_OPTIONS: { value: FilterMode; label: string; description: string }[] = [
  { value: "no-noise", label: "Hide noise", description: "Hides ticks and heartbeats" },
  { value: "agent-only", label: "Agent only", description: "Messages, tools, and lifecycle" },
  { value: "all", label: "Everything", description: "Including ticks and heartbeats" },
];

function shouldShow(evt: LiveEvent, filter: FilterMode): boolean {
  if (filter === "all") return true;
  const k = evt.parsed.kind;
  if (filter === "no-noise") return k !== "tick" && k !== "heartbeat";
  return k === "user_text" || k === "assistant_text" || k === "tool_call" || k === "tool_result" || k === "lifecycle";
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LiveFeed() {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<FilterMode>("no-noise");
  const [filterOpen, setFilterOpen] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const eventIdRef = useRef(0);
  const lastAssistantTextRef = useRef(new Map<string, string>());

  useEffect(() => {
    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          const { parsed, stream, channelOverride } = parseGatewayEvent(data);

          const payload = data.payload as Record<string, unknown> | undefined;
          const sessionKey = payload?.sessionKey as string | undefined;
          const runId = payload?.runId as string | undefined;
          const entryId = payload?.entryId as string | undefined;
          const ts = payload?.ts ? new Date(payload.ts as number).toISOString() : new Date().toISOString();

          let agentId: string | undefined;
          let channel: string | undefined;
          if (sessionKey) {
            const parts = sessionKey.split(":");
            if (parts[0] === "agent" && parts.length >= 3) {
              agentId = parts[1];
              channel = parts[2] === "telegram" ? "telegram" : parts[2] === "slack" ? "slack" : parts[2] === "webchat" ? "webchat" : parts[2];
            } else if (parts[0] === "cron") {
              agentId = "cron";
              channel = "cron";
            }
          }

          if (parsed.kind === "assistant_text" && runId) {
            const prevText = lastAssistantTextRef.current.get(runId);
            if (prevText && parsed.text.startsWith(prevText.slice(0, Math.max(0, prevText.length - 5)))) {
              lastAssistantTextRef.current.set(runId, parsed.text);
              setEvents((prev) => {
                const idx = prev.findIndex(
                  (e) => e.parsed.kind === "assistant_text" && e.stream === "assistant" && prev.indexOf(e) < 20,
                );
                if (idx >= 0) {
                  const updated = [...prev];
                  updated[idx] = { ...updated[idx], parsed: { ...parsed }, timestamp: ts };
                  return updated;
                }
                return prev;
              });
              return;
            }
            lastAssistantTextRef.current.set(runId, parsed.text);
          }

          if (parsed.kind === "lifecycle" && parsed.phase === "end" && runId) {
            lastAssistantTextRef.current.delete(runId);
          }

          const event: LiveEvent = {
            id: String(eventIdRef.current++),
            type: data.type ?? "unknown",
            event: data.event,
            stream,
            entryId,
            agent_id: agentId,
            channel: channelOverride || channel,
            channel_name: sessionKey,
            source: undefined,
            payload: typeof data.payload === "string" ? data.payload : JSON.stringify(data.payload ?? data, null, 2),
            timestamp: ts,
            parsed,
          };
          setEvents((prev) => [event, ...prev].slice(0, 500));
        } catch {
          // ignore malformed messages
        }
      };

      wsRef.current = ws;
    }

    connect();
    return () => wsRef.current?.close();
  }, []);

  useEffect(() => {
    if (!paused && feedRef.current) {
      feedRef.current.scrollTop = 0;
    }
  }, [events, paused]);

  const clear = useCallback(() => {
    setEvents([]);
    lastAssistantTextRef.current.clear();
  }, []);

  const visibleEvents = events.filter((e) => shouldShow(e, filter));
  const hiddenCount = events.length - visibleEvents.length;

  return (
    <div>
      <PageHeader
        section="03"
        title="Live Feed"
        description="Real-time agent activity stream"
        actions={
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-sm">
              <StatusDot status={connected ? "healthy" : "error"} />
              <span className={connected ? "text-healthy" : "text-error"}>
                {connected ? "Connected" : "Reconnecting..."}
              </span>
            </div>

            {/* Filter dropdown */}
            <div className="relative">
              <button
                onClick={() => setFilterOpen((o) => !o)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-card border border-border hover:bg-cream-dark transition-colors"
              >
                <Filter className="w-3.5 h-3.5" />
                {FILTER_OPTIONS.find((o) => o.value === filter)?.label}
                {hiddenCount > 0 && (
                  <span className="ml-1 text-ink-faint">({hiddenCount} hidden)</span>
                )}
              </button>
              {filterOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setFilterOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 z-20 bg-card border border-border rounded-lg shadow-lg min-w-[200px] py-1">
                    {FILTER_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => { setFilter(opt.value); setFilterOpen(false); }}
                        className={`w-full text-left px-3 py-2 text-xs hover:bg-cream-dark transition-colors ${filter === opt.value ? "text-accent" : "text-ink-muted"}`}
                      >
                        <div className="font-medium">{opt.label}</div>
                        <div className="text-ink-faint mt-0.5">{opt.description}</div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <button
              onClick={() => setPaused((p) => !p)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-card border border-border hover:bg-cream-dark transition-colors"
            >
              {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              onClick={clear}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-card border border-border hover:bg-cream-dark transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear
            </button>
          </div>
        }
      />

      <div
        ref={feedRef}
        className="bg-card rounded-xl overflow-hidden max-h-[calc(100vh-220px)] overflow-y-auto"
      >
        {visibleEvents.length === 0 && (
          <div className="py-16 text-center text-sm text-ink-muted">
            {connected ? "Waiting for events..." : "Connecting to WebSocket..."}
          </div>
        )}
        <div className="divide-y divide-border/50">
          {visibleEvents.map((evt) => (
            <EventRow key={evt.id} event={evt} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry detail fetching (unchanged logic, cleaner presentation)
// ---------------------------------------------------------------------------

const entryCache = new Map<string, Record<string, unknown>>();

async function fetchEntryDetail(entryId: string): Promise<Record<string, unknown> | null> {
  if (entryCache.has(entryId)) return entryCache.get(entryId)!;
  try {
    const res = await fetch(`/api/sessions/entry/${encodeURIComponent(entryId)}`);
    if (!res.ok) return null;
    const json = await res.json();
    const data = json.data as Record<string, unknown>;
    entryCache.set(entryId, data);
    return data;
  } catch {
    return null;
  }
}

function formatDetail(data: Record<string, unknown>): string {
  if (data.type === "message") {
    const lines: string[] = [];
    if (data.role) lines.push(`Role: ${data.role}`);
    if (data.channel) lines.push(`Channel: ${data.channel}`);
    if (data.tokens) lines.push(`Tokens: ${data.tokens}`);
    if (data.costTotal) lines.push(`Cost: $${(data.costTotal as number).toFixed(4)}`);
    lines.push("");
    lines.push(data.content as string);
    return lines.join("\n");
  }
  if (data.type === "tool_call") {
    const lines: string[] = [];
    lines.push(`Tool: ${data.toolName}`);
    if (data.durationMs) lines.push(`Duration: ${data.durationMs}ms`);
    if (data.success !== null && data.success !== undefined) lines.push(`Success: ${data.success ? "yes" : "no"}`);
    if (data.input) {
      lines.push("");
      lines.push("--- Input ---");
      try {
        lines.push(JSON.stringify(JSON.parse(data.input as string), null, 2));
      } catch {
        lines.push(data.input as string);
      }
    }
    if (data.output) {
      lines.push("");
      lines.push("--- Output ---");
      lines.push(data.output as string);
    }
    return lines.join("\n");
  }
  return JSON.stringify(data, null, 2);
}

function fallbackDetail(event: LiveEvent): string {
  const { parsed } = event;
  if (parsed.kind === "user_text") {
    return (parsed.sender ? `From: ${parsed.sender}\n\n` : "") + parsed.text;
  }
  if (parsed.kind === "assistant_text") return parsed.text;
  if (parsed.kind === "tool_call") {
    return `Tool: ${parsed.toolName}` + (parsed.input ? `\nInput: ${parsed.input}` : "");
  }
  if (parsed.kind === "tool_result") {
    return `Tool: ${parsed.toolName}` + (parsed.output ? `\n\n${parsed.output}` : "");
  }
  return event.payload;
}

// ---------------------------------------------------------------------------
// Event row — the core redesign
// ---------------------------------------------------------------------------

function EventRow({ event }: { event: LiveEvent }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { parsed } = event;

  const handleClick = useCallback(() => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);

    if (event.entryId && !detail) {
      setLoading(true);
      fetchEntryDetail(event.entryId).then((data) => {
        setLoading(false);
        if (data) {
          setDetail(formatDetail(data));
        } else {
          setDetail(fallbackDetail(event));
        }
      });
    } else if (!detail) {
      setDetail(fallbackDetail(event));
    }
  }, [expanded, event, detail]);

  // Determine row style based on event kind (with dynamic overrides)
  const config = getEventStyle(parsed);
  const isCompact = config.compact;

  return (
    <div
      className={`group cursor-pointer transition-colors hover:bg-cream/40 ${config.rowClass}`}
      onClick={handleClick}
    >
      {/* Left accent border */}
      <div className={`flex ${isCompact ? "px-4 py-1" : "px-4 py-2.5"}`}>
        <div className={`w-0.5 shrink-0 rounded-full mr-3 ${config.borderColor}`} />

        <div className="flex-1 min-w-0">
          {/* Top line: icon + label + channel + timestamp */}
          <div className="flex items-center gap-2 min-w-0">
            <span className={`shrink-0 ${config.iconColor}`}>
              {config.icon}
            </span>
            <span className={`shrink-0 text-[11px] font-semibold uppercase tracking-wider ${config.labelColor}`}>
              {config.label(parsed)}
            </span>
            {event.channel && (
              <span className="text-[10px] text-ink-faint font-medium px-1.5 py-0.5 rounded bg-cream-dark/50">
                {event.channel}
              </span>
            )}
            {/* Expand indicator for expandable rows */}
            {!isCompact && (
              <span className="text-ink-faint opacity-0 group-hover:opacity-100 transition-opacity ml-auto shrink-0">
                {expanded
                  ? <ChevronDown className="w-3 h-3" />
                  : <ChevronRight className="w-3 h-3" />}
              </span>
            )}
            <span className="text-[10px] text-ink-faint font-mono tabular-nums shrink-0 ml-auto">
              {formatTime(event.timestamp)}
            </span>
          </div>

          {/* Content line — shown inline for non-compact events */}
          <EventInlineContent parsed={parsed} isCompact={isCompact} />
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="ml-[1.75rem] mr-4 mb-2">
          <pre className="text-[11px] font-mono text-ink bg-cream-dark rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
            {loading ? "Loading..." : (detail ?? fallbackDetail(event))}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-event-type visual configuration
// ---------------------------------------------------------------------------

type EventStyleConfig = {
  icon: React.ReactNode;
  iconColor: string;
  borderColor: string;
  labelColor: string;
  label: (p: ParsedEvent) => string;
  rowClass: string;
  compact: boolean;
};

const EVENT_STYLES: Record<string, EventStyleConfig> = {
  user_text: {
    icon: <User className="w-3.5 h-3.5" />,
    iconColor: "text-sky-400",
    borderColor: "bg-sky-400",
    labelColor: "text-sky-400",
    label: (p) => (p as { sender?: string }).sender ? `${(p as { sender: string }).sender}` : "User",
    rowClass: "",
    compact: false,
  },
  assistant_text: {
    icon: <Bot className="w-3.5 h-3.5" />,
    iconColor: "text-accent",
    borderColor: "bg-accent",
    labelColor: "text-accent",
    label: () => "Agent",
    rowClass: "",
    compact: false,
  },
  tool_call: {
    icon: <Terminal className="w-3 h-3" />,
    iconColor: "text-warning",
    borderColor: "bg-warning/40",
    labelColor: "text-warning",
    label: (p) => (p as { toolName: string }).toolName,
    rowClass: "pl-4",
    compact: false,
  },
  tool_result: {
    icon: <CheckCircle className="w-3 h-3" />,
    iconColor: "text-healthy",
    borderColor: "bg-transparent",
    labelColor: "text-healthy",
    label: (p) => {
      const tr = p as { success?: boolean; toolName: string };
      return tr.success === false ? `${tr.toolName} failed` : tr.toolName;
    },
    rowClass: "pl-4",
    compact: true,
  },
  lifecycle: {
    icon: <Zap className="w-3 h-3" />,
    iconColor: "text-accent-muted",
    borderColor: "bg-accent/20",
    labelColor: "text-accent-muted",
    label: (p) => {
      const lc = p as { phase: string; model?: string };
      if (lc.phase === "start") return lc.model ? `Run started  ${lc.model}` : "Run started";
      return "Run finished";
    },
    rowClass: "bg-cream-dark/30",
    compact: true,
  },
  health: {
    icon: <Heart className="w-3 h-3" />,
    iconColor: "text-ink-faint",
    borderColor: "bg-transparent",
    labelColor: "text-ink-faint",
    label: (p) => {
      const h = p as { ok: boolean; durationMs?: number };
      const dur = h.durationMs != null ? ` ${h.durationMs}ms` : "";
      return h.ok ? `Healthy${dur}` : `Unhealthy${dur}`;
    },
    rowClass: "opacity-50 hover:opacity-100",
    compact: true,
  },
  tick: {
    icon: <Radio className="w-3 h-3" />,
    iconColor: "text-ink-faint",
    borderColor: "bg-transparent",
    labelColor: "text-ink-faint",
    label: () => "Tick",
    rowClass: "opacity-30 hover:opacity-60",
    compact: true,
  },
  heartbeat: {
    icon: <Heart className="w-3 h-3" />,
    iconColor: "text-ink-faint",
    borderColor: "bg-transparent",
    labelColor: "text-ink-faint",
    label: () => "Heartbeat",
    rowClass: "opacity-40 hover:opacity-80",
    compact: true,
  },
  gateway_status: {
    icon: <Radio className="w-3.5 h-3.5" />,
    iconColor: "text-healthy",
    borderColor: "bg-healthy/40",
    labelColor: "text-healthy",
    label: (p) => `Gateway ${(p as { status: string }).status}`,
    rowClass: "bg-healthy-bg/30",
    compact: true,
  },
  unknown: {
    icon: <Zap className="w-3 h-3" />,
    iconColor: "text-ink-faint",
    borderColor: "bg-transparent",
    labelColor: "text-ink-faint",
    label: (p) => (p as { summary: string }).summary ?? "Unknown",
    rowClass: "",
    compact: true,
  },
};

// Override tool_result icon when failed
function getEventStyle(parsed: ParsedEvent): EventStyleConfig {
  const base = EVENT_STYLES[parsed.kind] ?? EVENT_STYLES.unknown;
  if (parsed.kind === "tool_result" && parsed.success === false) {
    return {
      ...base,
      icon: <XCircle className="w-3 h-3" />,
      iconColor: "text-error",
      labelColor: "text-error",
      borderColor: "bg-error/40",
    };
  }
  return base;
}


// ---------------------------------------------------------------------------
// Inline content — the second line shown without expanding
// ---------------------------------------------------------------------------

function EventInlineContent({ parsed, isCompact }: { parsed: ParsedEvent; isCompact: boolean }) {
  switch (parsed.kind) {
    case "user_text":
      return (
        <p className="mt-1 text-[13px] text-ink leading-relaxed line-clamp-3">
          {parsed.text}
        </p>
      );

    case "assistant_text":
      return (
        <p className="mt-1 text-[13px] text-ink/80 leading-relaxed line-clamp-3">
          {parsed.text}
        </p>
      );

    case "tool_call":
      return parsed.input ? (
        <p className="mt-0.5 text-[11px] font-mono text-ink-faint truncate">
          {parsed.input}
        </p>
      ) : null;

    case "tool_result":
      if (isCompact) {
        return parsed.durationMs != null ? (
          <span className="inline text-[10px] text-ink-faint font-mono ml-2">
            {parsed.durationMs}ms
          </span>
        ) : null;
      }
      return null;

    case "heartbeat":
      return parsed.preview ? (
        <span className="text-[11px] text-ink-faint ml-2 truncate">{parsed.preview.slice(0, 100)}</span>
      ) : null;

    default:
      return null;
  }
}
