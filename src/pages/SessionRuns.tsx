import { useParams, Link } from "react-router";
import { PageHeader } from "@/components/layout/PageHeader";
import { useSessionRuns, useSessions, type RunSummary } from "@/lib/api";
import { ChannelBadge, Badge, StatusDot } from "@/components/ui/badge";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  formatRelativeTime,
  formatNumber,
  formatCost,
  formatDuration,
  formatSessionName,
  truncate,
} from "@/lib/utils";
import {
  ChevronLeft,
  MessageSquare,
  Wrench,
  DollarSign,
  Cpu,
} from "lucide-react";

export function SessionRuns() {
  const { agentId, sessionId } = useParams();
  const { data, error, mutate } = useSessionRuns(agentId!, sessionId!);
  const { data: sessionsData } = useSessions();

  // Look up session metadata for the header
  const session = sessionsData?.items.find(
    (s) => s.agentId === agentId && s.sessionId === sessionId,
  );
  const sessionName = session
    ? formatSessionName(session.sessionKey, session.channel)
    : "Session";

  if (error) return <ErrorState message="Failed to load runs" onRetry={() => mutate()} />;
  if (!data) return <PageSkeleton />;

  const runs = data.runs;
  const totalCost = runs.reduce((sum, r) => sum + r.total_cost, 0);
  const totalMessages = runs.reduce((sum, r) => sum + r.message_count, 0);

  return (
    <div>
      <Link
        to="/activity"
        className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink mb-3 transition-colors"
      >
        <ChevronLeft className="w-3.5 h-3.5" /> Sessions
      </Link>

      <PageHeader
        title={sessionName}
        description={`${runs.length} runs · ${formatNumber(totalMessages)} messages · ${formatCost(totalCost)}`}
      />

      {runs.length === 0 && (
        <div className="py-16 text-center text-sm text-ink-muted">
          No runs tracked for this session yet
        </div>
      )}

      <div className="divide-y divide-border/60">
        {runs.map((run) => (
          <RunRow
            key={run.run_id}
            run={run}
            agentId={agentId!}
            sessionId={sessionId!}
          />
        ))}
      </div>
    </div>
  );
}

function RunRow({ run, agentId, sessionId }: { run: RunSummary; agentId: string; sessionId: string }) {
  const isRunning = run.status === "running" || !run.ended_at;
  const summary = run.first_user_message
    ? truncate(run.first_user_message.replace(/\n/g, " ").trim(), 140)
    : null;

  // Shorten model name for display
  const modelShort = run.model
    ? run.model.replace(/^anthropic\//, "").replace(/^openai\//, "")
    : null;

  return (
    <Link
      to={`/activity/${agentId}/${sessionId}/${run.run_id}`}
      className="block py-3 px-2 -mx-2 rounded-lg hover:bg-cream-dark/50 transition-colors group"
    >
      {/* Top line: status + channel + time */}
      <div className="flex items-center gap-2 mb-1">
        <span className="shrink-0">
          {isRunning ? (
            <StatusDot status="healthy" />
          ) : (
            <span className="block w-1.5 h-1.5 rounded-full bg-ink-faint/50" />
          )}
        </span>
        <ChannelBadge channel={run.channel} />
        {modelShort && <Badge variant="muted">{modelShort}</Badge>}
        {isRunning && (
          <span className="text-xs text-healthy font-medium">running</span>
        )}
        <span className="ml-auto text-xs text-ink-faint shrink-0">
          {formatRelativeTime(run.started_at)}
        </span>
      </div>

      {/* Summary */}
      {summary ? (
        <p className="text-sm text-ink leading-relaxed mb-1.5 pl-5">
          {summary}
        </p>
      ) : (
        <p className="text-sm text-ink-faint italic mb-1.5 pl-5">
          No user message
        </p>
      )}

      {/* Stats row */}
      <div className="flex items-center gap-4 pl-5 text-[11px] text-ink-faint">
        <span className="flex items-center gap-1">
          <MessageSquare className="w-3 h-3" />
          {run.message_count} msgs
        </span>
        {run.tool_call_count > 0 && (
          <span className="flex items-center gap-1">
            <Wrench className="w-3 h-3" />
            {run.tool_call_count} tools
          </span>
        )}
        {run.total_cost > 0 && (
          <span className="flex items-center gap-1">
            <DollarSign className="w-3 h-3" />
            {formatCost(run.total_cost)}
          </span>
        )}
        {run.duration_ms != null && (
          <span className="flex items-center gap-1">
            <Cpu className="w-3 h-3" />
            {formatDuration(run.duration_ms)}
          </span>
        )}
      </div>
    </Link>
  );
}
