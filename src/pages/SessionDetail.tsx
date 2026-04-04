import { useParams, Link } from "react-router";
import { PageHeader } from "@/components/layout/PageHeader";
import { useSessionDetail, type SessionMessage, type ToolCall } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { formatTime, formatCost, cn } from "@/lib/utils";
import { ChevronLeft, ChevronDown, ChevronRight, User, Bot, Terminal, Copy, Check, Info, Wrench } from "lucide-react";
import { useState, useMemo, useCallback } from "react";

// --- Content parsing ---

type ParsedContent = {
  text: string;
  metadata: { sender?: string; raw: string } | null;
  isSystemInstruction: boolean;
};

function parseUserContent(content: string | null): ParsedContent {
  if (!content) return { text: "", metadata: null, isSystemInstruction: false };
  if (content.startsWith("A new session was started via")) {
    return { text: "", metadata: null, isSystemInstruction: true };
  }
  const metadataPattern = /^(Conversation info \(untrusted metadata\):\n```json\n[\s\S]*?\n```\n\nSender \(untrusted metadata\):\n```json\n[\s\S]*?\n```)\s*\n*([\s\S]*)$/;
  const match = content.match(metadataPattern);
  if (!match) return { text: content, metadata: null, isSystemInstruction: false };
  const rawMeta = match[1];
  const actualText = match[2].trim();
  let sender: string | undefined;
  try {
    const senderJsonMatch = rawMeta.match(/Sender[\s\S]*?```json\s*\n([\s\S]*?)```/);
    if (senderJsonMatch) sender = JSON.parse(senderJsonMatch[1]).name;
  } catch { /* ignore */ }
  return { text: actualText, metadata: { sender, raw: rawMeta }, isSystemInstruction: false };
}

function cleanAssistantContent(content: string | null): string {
  if (!content) return "";
  return content.replace(/^\[\[[\w_]+\]\]\s*/g, "").trim();
}

// --- Turn grouping ---

type ToolCallWithResult = {
  call: ToolCall;
  result?: SessionMessage;
};

type ConversationTurn =
  | { kind: "user"; message: SessionMessage }
  | { kind: "assistant"; firstMessage: SessionMessage; textContent: string; toolCallsWithResults: ToolCallWithResult[]; allMessages: SessionMessage[] }
  | { kind: "system"; message: SessionMessage };

/**
 * Group messages into conversation turns. Merges consecutive
 * assistant→toolResult→assistant→toolResult→...→assistant chains into one turn,
 * since the agent often does: call tool, get result, call another, get result, then reply.
 */
function groupIntoTurns(messages: SessionMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "user") {
      turns.push({ kind: "user", message: msg });
      i++;
    } else if (msg.role === "assistant") {
      // Consume the entire assistant chain: assistant(+toolResults)* until we hit a user or end
      const allMessages: SessionMessage[] = [msg];
      const toolCallsWithResults: ToolCallWithResult[] = [];
      const textParts: string[] = [];

      // Collect tool calls from this first message
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          toolCallsWithResults.push({ call: tc });
        }
      }
      const cleanedFirst = cleanAssistantContent(msg.content);
      if (cleanedFirst) textParts.push(cleanedFirst);

      let j = i + 1;
      while (j < messages.length && messages[j].role !== "user") {
        const next = messages[j];
        allMessages.push(next);

        if (next.role === "toolResult") {
          // Attach to the last tool call that doesn't have a result yet
          const unmatched = toolCallsWithResults.find((t) => !t.result);
          if (unmatched) unmatched.result = next;
        } else if (next.role === "assistant") {
          // Another assistant message in the chain — collect its tool calls and text
          if (next.toolCalls) {
            for (const tc of next.toolCalls) {
              toolCallsWithResults.push({ call: tc });
            }
          }
          const cleanedNext = cleanAssistantContent(next.content);
          if (cleanedNext) textParts.push(cleanedNext);
        }
        j++;
      }

      turns.push({
        kind: "assistant",
        firstMessage: msg,
        textContent: textParts.join("\n\n"),
        toolCallsWithResults,
        allMessages,
      });
      i = j;
    } else if (msg.role === "toolResult") {
      turns.push({ kind: "system", message: msg });
      i++;
    } else {
      turns.push({ kind: "system", message: msg });
      i++;
    }
  }
  return turns;
}

// --- Copy transcript ---

function serializeTranscript(turns: ConversationTurn[]): string {
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.kind === "user") {
      lines.push(`== USER [${formatTime(turn.message.timestamp)}] ==`);
      lines.push(turn.message.content ?? "");
      lines.push("");
    } else if (turn.kind === "assistant") {
      const totalCost = turn.allMessages.reduce((sum, m) => {
        if (m.role !== "assistant") return sum;
        const c = m.tokenUsage?.cost as Record<string, number> | undefined;
        return sum + (c?.total ?? 0);
      }, 0);
      const costStr = totalCost > 0 ? ` (${formatCost(totalCost)})` : "";
      lines.push(`== ASSISTANT [${formatTime(turn.firstMessage.timestamp)}]${costStr} ==`);
      if (turn.toolCallsWithResults.length) {
        for (const tcr of turn.toolCallsWithResults) {
          lines.push(`  [TOOL CALL] ${tcr.call.name}`);
          if (tcr.call.arguments) {
            const argStr = typeof tcr.call.arguments.command === "string" ? tcr.call.arguments.command : JSON.stringify(tcr.call.arguments, null, 2);
            for (const line of argStr.split("\n")) lines.push(`    ${line}`);
          }
          if (tcr.result?.content) {
            lines.push(`  [RESULT]`);
            for (const line of tcr.result.content.split("\n")) lines.push(`    ${line}`);
          }
          lines.push("");
        }
      }
      if (turn.textContent.trim()) { lines.push(turn.textContent); lines.push(""); }
    } else {
      lines.push(`== SYSTEM [${formatTime(turn.message.timestamp)}] ==`);
      lines.push(turn.message.content ?? "");
      lines.push("");
    }
  }
  return lines.join("\n");
}

// --- Main component ---

export function SessionDetail() {
  const { agentId, sessionId, runId } = useParams();
  const { data, error, mutate } = useSessionDetail(agentId!, sessionId!);
  const [copied, setCopied] = useState(false);

  // If we have a runId, filter messages to just that run
  const allTurns = useMemo(() => (data ? groupIntoTurns(data.items) : []), [data]);

  // Filter turns by runId if provided — match messages that belong to this run
  // Since JSONL doesn't have run_id per message, we show all turns for now
  // (the run-level filtering is a future DB-backed improvement)
  const turns = allTurns;

  const handleCopy = useCallback(() => {
    const text = serializeTranscript(turns);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [turns]);

  if (error) return <ErrorState message="Failed to load session" onRetry={() => mutate()} />;
  if (!data) return <PageSkeleton />;

  const userCount = turns.filter((t) => t.kind === "user").length;
  const assistantCount = turns.filter((t) => t.kind === "assistant").length;
  const totalCost = turns.reduce((sum, t) => {
    if (t.kind !== "assistant") return sum;
    return sum + t.allMessages.reduce((s, m) => {
      if (m.role !== "assistant") return s;
      const cost = m.tokenUsage?.cost as Record<string, number> | undefined;
      return s + (cost?.total ?? 0);
    }, 0);
  }, 0);

  const backUrl = runId
    ? `/activity/${agentId}/${sessionId}`
    : "/activity";
  const backLabel = runId ? "Runs" : "Sessions";

  return (
    <div>
      <Link to={backUrl} className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink mb-3 transition-colors">
        <ChevronLeft className="w-3.5 h-3.5" /> {backLabel}
      </Link>

      <PageHeader
        title="Transcript"
        description={`${userCount} user, ${assistantCount} agent · ${totalCost > 0 ? formatCost(totalCost) : "no cost data"}`}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors",
                copied ? "bg-healthy/10 text-healthy" : "bg-card border border-border hover:bg-cream-dark text-ink-muted",
              )}
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Copied!" : "Copy Transcript"}
            </button>
            <Badge variant="muted">{agentId}</Badge>
          </div>
        }
      />

      <div className="space-y-4 max-w-4xl">
        {turns.map((turn, i) => (
          <TurnView key={i} turn={turn} />
        ))}
        {turns.length === 0 && (
          <p className="text-sm text-ink-muted py-12 text-center">No messages in this session</p>
        )}
      </div>
    </div>
  );
}

// --- Turn rendering ---

function TurnView({ turn }: { turn: ConversationTurn }) {
  if (turn.kind === "user") return <UserMessage message={turn.message} />;
  if (turn.kind === "assistant") return <AssistantTurn turn={turn} />;
  return <SystemMessage message={turn.message} />;
}

function UserMessage({ message }: { message: SessionMessage }) {
  const parsed = useMemo(() => parseUserContent(message.content), [message.content]);
  const [showMeta, setShowMeta] = useState(false);

  if (parsed.isSystemInstruction) {
    return (
      <div className="mx-4 px-4 py-2 rounded-lg bg-cream-dark/50 text-center">
        <span className="text-xs text-ink-faint">Session started</span>
      </div>
    );
  }
  if (!parsed.text && parsed.metadata) return null;

  const senderName = parsed.metadata?.sender ?? "You";

  return (
    <div className="flex gap-3">
      <div className="w-8 h-8 rounded-lg bg-cream-dark flex items-center justify-center shrink-0 mt-1">
        <User className="w-4 h-4 text-ink-muted" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-semibold text-ink uppercase tracking-wider">{senderName}</span>
          <span className="text-[11px] text-ink-faint font-mono">{formatTime(message.timestamp)}</span>
          {parsed.metadata && (
            <button onClick={() => setShowMeta((s) => !s)} className="text-ink-faint hover:text-ink-muted transition-colors" title="Show metadata">
              <Info className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="text-sm text-ink leading-relaxed whitespace-pre-wrap break-words">{parsed.text}</div>
        {showMeta && parsed.metadata && (
          <pre className="mt-2 text-[11px] font-mono text-ink-faint bg-cream-dark rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
            {parsed.metadata.raw}
          </pre>
        )}
      </div>
    </div>
  );
}

function AssistantTurn({ turn }: { turn: Extract<ConversationTurn, { kind: "assistant" }> }) {
  const hasToolCalls = turn.toolCallsWithResults.length > 0;
  const hasText = turn.textContent.length > 0;

  // Sum cost across all assistant messages in this chain
  const totalCost = turn.allMessages.reduce((sum, m) => {
    if (m.role !== "assistant") return sum;
    const cost = m.tokenUsage?.cost as Record<string, number> | undefined;
    return sum + (cost?.total ?? 0);
  }, 0);

  if (!hasText && !hasToolCalls) return null;

  return (
    <div className="flex gap-3">
      <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-1">
        <Bot className="w-4 h-4 text-accent" />
      </div>
      <div className="flex-1 min-w-0 space-y-3">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-semibold text-accent uppercase tracking-wider">Agent</span>
          <span className="text-[11px] text-ink-faint font-mono">{formatTime(turn.firstMessage.timestamp)}</span>
          {totalCost > 0 && <span className="text-[10px] text-ink-faint font-mono">{formatCost(totalCost)}</span>}
        </div>

        {hasToolCalls && (
          <ToolCallsCard toolCallsWithResults={turn.toolCallsWithResults} />
        )}

        {hasText && (
          <div className="text-sm text-ink leading-relaxed whitespace-pre-wrap break-words">{turn.textContent}</div>
        )}
      </div>
    </div>
  );
}

// --- Single unified tool calls card ---

function ToolCallsCard({ toolCallsWithResults }: { toolCallsWithResults: ToolCallWithResult[] }) {
  return (
    <div className="rounded-xl border border-border overflow-hidden bg-cream/30">
      {toolCallsWithResults.map((tcr, i) => (
        <ToolCallRow key={tcr.call.id ?? i} toolCall={tcr.call} result={tcr.result} isLast={i === toolCallsWithResults.length - 1} />
      ))}
    </div>
  );
}

function ToolCallRow({ toolCall, result, isLast }: { toolCall: ToolCall; result?: SessionMessage; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const toolColors: Record<string, string> = {
    exec: "bg-orange-500/15 text-orange-400",
    memory_search: "bg-purple-500/15 text-purple-400",
    web_search: "bg-blue-500/15 text-blue-400",
    web_fetch: "bg-blue-500/15 text-blue-400",
    file_read: "bg-green-500/15 text-green-400",
    file_write: "bg-green-500/15 text-green-400",
  };
  const colorClass = toolColors[toolCall.name] ?? "bg-cream-dark text-ink-muted";

  const hasError = result?.content?.includes("error") || result?.content?.includes("Error") || result?.content?.includes("Traceback");

  // Build a short preview of what was called
  let preview = "";
  if (toolCall.arguments) {
    if (typeof toolCall.arguments.command === "string") {
      preview = toolCall.arguments.command.split("\n")[0];
    } else if (typeof toolCall.arguments.query === "string") {
      preview = toolCall.arguments.query;
    } else {
      const keys = Object.keys(toolCall.arguments);
      if (keys.length > 0) preview = keys.join(", ");
    }
  }
  if (preview.length > 80) preview = preview.slice(0, 80) + "...";

  return (
    <div className={cn(!isLast && !expanded && "border-b border-border")}>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 hover:bg-cream/50 transition-colors"
      >
        <Wrench className="w-3.5 h-3.5 text-ink-faint shrink-0" />
        <span className={cn("text-[11px] font-medium px-1.5 py-0.5 rounded shrink-0", colorClass)}>
          {toolCall.name}
        </span>
        <span className="text-xs text-ink-muted truncate flex-1">{preview}</span>
        {hasError && <Badge variant="error">err</Badge>}
        <span className="shrink-0">
          {expanded ? <ChevronDown className="w-3.5 h-3.5 text-ink-faint" /> : <ChevronRight className="w-3.5 h-3.5 text-ink-faint" />}
        </span>
      </button>

      {expanded && (
        <div className={cn("px-4 pb-3 space-y-2", !isLast && "border-b border-border")}>
          {toolCall.arguments && (
            <div>
              <p className="text-[10px] text-ink-faint uppercase tracking-wider mb-1">Input</p>
              <pre className="text-[11px] font-mono text-ink-muted bg-cream-dark rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                {typeof toolCall.arguments.command === "string" ? toolCall.arguments.command : JSON.stringify(toolCall.arguments, null, 2)}
              </pre>
            </div>
          )}
          {result?.content && (
            <div>
              <p className="text-[10px] text-ink-faint uppercase tracking-wider mb-1">Result</p>
              <pre className="text-[11px] font-mono text-ink-muted bg-card rounded-md px-3 py-2 overflow-x-auto whitespace-pre-wrap break-words max-h-48 overflow-y-auto border border-border">
                {result.content}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SystemMessage({ message }: { message: SessionMessage }) {
  return (
    <div className="mx-4 px-4 py-2 rounded-lg bg-cream-dark/50 text-center">
      <span className="text-xs text-ink-faint">{message.content ?? "system"}</span>
    </div>
  );
}
