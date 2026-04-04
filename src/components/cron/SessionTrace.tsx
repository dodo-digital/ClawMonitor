import { useState } from "react";
import { MessageSquare, Wrench, ChevronDown, ChevronRight, CheckCircle, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDuration, formatLocal, cn } from "@/lib/utils";
import type { SessionTrace as SessionTraceType, CronSession, SessionTraceToolCall } from "@/lib/api";

type Props = {
  trace: SessionTraceType;
  sessions: CronSession[];
};

export function SessionTrace({ trace, sessions }: Props) {
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());

  const totalTokens = trace.messages.reduce((sum, m) => sum + (m.tokens ?? 0), 0);
  const totalCost = trace.messages.reduce((sum, m) => sum + (m.cost_total ?? 0), 0);

  function toggleTool(idx: number) {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  // Interleave messages and tool calls by timestamp
  type TimelineItem =
    | { kind: "message"; data: SessionTraceType["messages"][0]; idx: number }
    | { kind: "tool"; data: SessionTraceToolCall; idx: number };

  const timeline: TimelineItem[] = [
    ...trace.messages.map((m, idx) => ({ kind: "message" as const, data: m, idx })),
    ...trace.tool_calls.map((t, idx) => ({ kind: "tool" as const, data: t, idx })),
  ].sort((a, b) => new Date(a.data.timestamp).getTime() - new Date(b.data.timestamp).getTime());

  return (
    <div className="space-y-4">
      {/* Summary stats */}
      <div className="flex items-center gap-4 text-xs text-ink-muted">
        <span>{trace.messages.length} messages</span>
        <span>{trace.tool_calls.length} tool calls</span>
        {totalTokens > 0 && <span>{totalTokens.toLocaleString()} tokens</span>}
        {totalCost > 0 && <span>${totalCost.toFixed(4)}</span>}
      </div>

      {/* Session info */}
      {sessions.length > 0 && (
        <div className="bg-cream rounded-lg p-3 text-xs space-y-1">
          <div className="text-ink-faint font-medium uppercase tracking-wider mb-1">Latest Session</div>
          <div className="flex gap-4 text-ink-muted">
            <span>Agent: {sessions[0].agent_id}</span>
            <span>Model: {sessions[0].model}</span>
            {sessions[0].duration_ms && <span>Duration: {formatDuration(sessions[0].duration_ms)}</span>}
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="space-y-1.5">
        {timeline.map((item) => {
          if (item.kind === "message") {
            const m = item.data;
            return (
              <div key={`msg-${item.idx}`} className="flex gap-2 py-1.5">
                <MessageSquare className={cn(
                  "w-3.5 h-3.5 mt-0.5 flex-shrink-0",
                  m.role === "assistant" ? "text-accent" : "text-ink-faint",
                )} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <Badge variant={m.role === "assistant" ? "accent" : "muted"} className="text-[10px]">
                      {m.role}
                    </Badge>
                    <span className="text-[10px] text-ink-faint">{formatLocal(m.timestamp)}</span>
                    {m.tokens > 0 && <span className="text-[10px] text-ink-faint">{m.tokens} tok</span>}
                  </div>
                  <p className="text-xs text-ink-muted whitespace-pre-wrap break-words line-clamp-4">
                    {m.content || "(empty)"}
                  </p>
                </div>
              </div>
            );
          }

          const t = item.data;
          const expanded = expandedTools.has(item.idx);
          return (
            <div key={`tool-${item.idx}`} className="border border-border rounded-lg overflow-hidden">
              <button
                onClick={() => toggleTool(item.idx)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-cream/50 transition-colors text-left"
              >
                {expanded ? <ChevronDown className="w-3 h-3 text-ink-faint" /> : <ChevronRight className="w-3 h-3 text-ink-faint" />}
                <Wrench className="w-3.5 h-3.5 text-ink-faint flex-shrink-0" />
                <span className="text-xs font-mono text-ink flex-1 truncate">{t.tool_name}</span>
                {t.success ? (
                  <CheckCircle className="w-3 h-3 text-healthy flex-shrink-0" />
                ) : (
                  <XCircle className="w-3 h-3 text-error flex-shrink-0" />
                )}
                {t.duration_ms > 0 && (
                  <span className="text-[10px] text-ink-faint">{formatDuration(t.duration_ms)}</span>
                )}
                <span className="text-[10px] text-ink-faint">{formatLocal(t.timestamp)}</span>
              </button>
              {expanded && (
                <div className="border-t border-border px-3 py-2 space-y-2 bg-cream/30">
                  {t.input && (
                    <div>
                      <span className="text-[10px] font-medium text-ink-faint uppercase">Input</span>
                      <pre className="text-[11px] font-mono text-ink-muted whitespace-pre-wrap break-words mt-0.5 max-h-40 overflow-auto">
                        {truncateStr(t.input, 2000)}
                      </pre>
                    </div>
                  )}
                  {t.output && (
                    <div>
                      <span className="text-[10px] font-medium text-ink-faint uppercase">Output</span>
                      <pre className="text-[11px] font-mono text-ink-muted whitespace-pre-wrap break-words mt-0.5 max-h-40 overflow-auto">
                        {truncateStr(t.output, 2000)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function truncateStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (${s.length - max} more chars)`;
}
