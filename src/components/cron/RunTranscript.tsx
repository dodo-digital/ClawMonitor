import { useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Brain, Terminal, FileText, Globe, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useCronRunTranscript, type TranscriptItem } from "@/lib/api";
import { formatLocal, cn } from "@/lib/utils";

type RunTranscriptProps = {
  jobId: string;
  sessionId: string;
  runSummary?: string;
  onBack: () => void;
};

const toolColors: Record<string, { bg: string; text: string; icon: React.ElementType }> = {
  exec: { bg: "bg-orange-500/10", text: "text-orange-500", icon: Terminal },
  read: { bg: "bg-emerald-500/10", text: "text-emerald-500", icon: FileText },
  write: { bg: "bg-blue-500/10", text: "text-blue-500", icon: Pencil },
  message: { bg: "bg-purple-500/10", text: "text-purple-500", icon: Globe },
};

function getToolStyle(name: string) {
  const lower = name.toLowerCase();
  if (lower === "exec" || lower === "bash" || lower.includes("command")) return toolColors.exec;
  if (lower === "read" || lower.includes("read")) return toolColors.read;
  if (lower === "write" || lower.includes("write") || lower === "edit") return toolColors.write;
  if (lower === "message" || lower.includes("send")) return toolColors.message;
  return { bg: "bg-ink-faint/10", text: "text-ink-muted", icon: Terminal };
}

function ToolCallBlock({ tool }: { tool: { name: string; arguments: unknown; id?: string } }) {
  const [expanded, setExpanded] = useState(false);
  const style = getToolStyle(tool.name);
  const Icon = style.icon;

  const argsStr = typeof tool.arguments === "string"
    ? tool.arguments
    : JSON.stringify(tool.arguments, null, 2);

  // Extract a useful preview from args
  let preview = "";
  if (typeof tool.arguments === "object" && tool.arguments) {
    const args = tool.arguments as Record<string, unknown>;
    preview = String(args.file_path ?? args.path ?? args.command ?? args.pattern ?? "").slice(0, 80);
  }

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-cream/40 transition-colors text-left"
      >
        {expanded ? <ChevronDown className="w-3 h-3 text-ink-faint" /> : <ChevronRight className="w-3 h-3 text-ink-faint" />}
        <span className={cn("flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium", style.bg, style.text)}>
          <Icon className="w-3 h-3" />
          {tool.name}
        </span>
        {preview && <span className="text-[11px] text-ink-faint font-mono truncate">{preview}</span>}
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t border-border/30">
          <pre className="text-[11px] font-mono text-ink-muted whitespace-pre-wrap break-words mt-2 max-h-64 overflow-auto bg-cream/40 rounded p-2">
            {argsStr}
          </pre>
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border/30 rounded-lg overflow-hidden bg-cream/20">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-cream/40 transition-colors text-left"
      >
        {expanded ? <ChevronDown className="w-3 h-3 text-ink-faint" /> : <ChevronRight className="w-3 h-3 text-ink-faint" />}
        <Brain className="w-3 h-3 text-ink-faint" />
        <span className="text-[11px] text-ink-faint">Thinking</span>
      </button>
      {expanded && (
        <pre className="px-3 pb-3 text-[11px] font-mono text-ink-faint whitespace-pre-wrap break-words max-h-48 overflow-auto">
          {text}
        </pre>
      )}
    </div>
  );
}

function MessageBlock({ item }: { item: TranscriptItem }) {
  if (item.role === "_session" || item.role === "_model") {
    return (
      <div className="text-[10px] text-ink-faint text-center py-1">
        {item.role === "_model" ? `Model: ${item.provider}/${item.modelId}` : `Session started`}
      </div>
    );
  }

  if (item.role === "user") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Badge variant="default">Prompt</Badge>
          {item.timestamp && <span className="text-[10px] text-ink-faint">{formatLocal(item.timestamp)}</span>}
        </div>
        <div className="bg-accent/5 border border-accent/20 rounded-lg p-3">
          <pre className="text-xs text-ink whitespace-pre-wrap break-words">{item.content}</pre>
        </div>
      </div>
    );
  }

  if (item.role === "assistant") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Badge variant="muted">Assistant</Badge>
          {item.timestamp && <span className="text-[10px] text-ink-faint">{formatLocal(item.timestamp)}</span>}
        </div>

        {item.thinkingBlocks.map((text, i) => (
          <ThinkingBlock key={i} text={text} />
        ))}

        {item.toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {item.toolCalls.map((tc, i) => (
              <ToolCallBlock key={i} tool={tc} />
            ))}
          </div>
        )}

        {item.content && (
          <div className="text-sm text-ink whitespace-pre-wrap">{item.content}</div>
        )}
      </div>
    );
  }

  return null;
}

export function RunTranscript({ jobId, sessionId, runSummary, onBack }: RunTranscriptProps) {
  const { data, error } = useCronRunTranscript(jobId, sessionId);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to runs
      </button>

      {runSummary && (
        <div className="bg-cream/60 rounded-lg px-3 py-2 text-xs text-ink-muted">
          {runSummary}
        </div>
      )}

      {error && <div className="text-sm text-error">Failed to load transcript</div>}
      {!data && !error && <div className="skeleton h-32 w-full" />}

      {data && (
        <div className="space-y-4">
          {data.items.map((item, i) => (
            <MessageBlock key={i} item={item} />
          ))}

          {data.items.length === 0 && (
            <div className="text-sm text-ink-muted py-4">No transcript data available for this run</div>
          )}
        </div>
      )}
    </div>
  );
}
