import { useState, useMemo } from "react";
import { Link } from "react-router";
import { PageHeader } from "@/components/layout/PageHeader";
import { useSessions, type Session } from "@/lib/api";
import { ChannelBadge, Badge } from "@/components/ui/badge";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  formatRelativeTime,
  formatNumber,
  formatCost,
  formatDuration,
  truncate,
  cn,
} from "@/lib/utils";
import { Search, MessageSquare, Wrench, DollarSign, Clock, ChevronDown, ChevronRight } from "lucide-react";

export function Sessions() {
  const { data, error, mutate } = useSessions();
  const [search, setSearch] = useState("");
  const [cronExpanded, setCronExpanded] = useState(false);

  const { conversations, cronSessions, systemSessions } = useMemo(() => {
    if (!data) return { conversations: [], cronSessions: [], systemSessions: [] };
    const items = data.items.filter((s) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        s.displayName.toLowerCase().includes(q) ||
        (s.lastUserMessage ?? "").toLowerCase().includes(q) ||
        s.sessionKey.toLowerCase().includes(q)
      );
    });
    return {
      conversations: items.filter((s) => s.category === "conversation"),
      cronSessions: items.filter((s) => s.category === "cron"),
      systemSessions: items.filter((s) => s.category === "system"),
    };
  }, [data, search]);

  if (error) return <ErrorState message="Failed to load sessions" onRetry={() => mutate()} />;
  if (!data) return <PageSkeleton />;

  const totalCost = data.items.reduce((sum, s) => sum + s.totalCost, 0);

  return (
    <div>
      <PageHeader
        title="Sessions"
        description={`${data.items.length} channels · ${formatCost(totalCost)} total`}
      />

      {/* Search */}
      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-faint" />
          <input
            type="text"
            placeholder="Search sessions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-cream-dark border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent/40 placeholder:text-ink-faint"
          />
        </div>
        {search && (
          <button onClick={() => setSearch("")} className="text-xs text-accent hover:underline">
            Clear
          </button>
        )}
      </div>

      {/* Conversations */}
      {conversations.length > 0 && (
        <div className="mb-6">
          <SectionLabel>Conversations</SectionLabel>
          <div className="divide-y divide-border/60">
            {conversations.map((session) => (
              <SessionRow key={session.sessionKey} session={session} />
            ))}
          </div>
        </div>
      )}

      {/* System */}
      {systemSessions.length > 0 && (
        <div className="mb-6">
          <SectionLabel>System</SectionLabel>
          <div className="divide-y divide-border/60">
            {systemSessions.map((session) => (
              <SessionRow key={session.sessionKey} session={session} />
            ))}
          </div>
        </div>
      )}

      {/* Cron — collapsible */}
      {cronSessions.length > 0 && (
        <div className="mb-6">
          <button
            onClick={() => setCronExpanded(!cronExpanded)}
            className="flex items-center gap-1.5 mb-2 group"
          >
            {cronExpanded
              ? <ChevronDown className="w-3 h-3 text-ink-faint" />
              : <ChevronRight className="w-3 h-3 text-ink-faint" />}
            <span className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider group-hover:text-ink-muted transition-colors">
              Cron Jobs
            </span>
            <span className="text-[10px] text-ink-faint">
              ({cronSessions.length})
            </span>
          </button>
          {cronExpanded && (
            <div className="divide-y divide-border/60">
              {cronSessions.map((session) => (
                <SessionRow key={session.sessionKey} session={session} />
              ))}
            </div>
          )}
        </div>
      )}

      {conversations.length === 0 && cronSessions.length === 0 && systemSessions.length === 0 && (
        <div className="py-16 text-center text-sm text-ink-muted">
          No sessions match your search
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-2">{children}</h3>
  );
}

function SessionRow({ session }: { session: Session }) {
  const summary = session.lastUserMessage
    ? truncate(session.lastUserMessage.replace(/\n/g, " ").trim(), 120)
    : null;

  return (
    <Link
      to={`/activity/${session.agentId}/${encodeURIComponent(session.sessionId)}`}
      className="block py-3 px-2 -mx-2 rounded-lg hover:bg-cream-dark/50 transition-colors group"
    >
      {/* Top line: channel badge + display name + time */}
      <div className="flex items-center gap-2 mb-1">
        <ChannelBadge channel={session.channel} />
        <span className="text-sm font-medium text-ink group-hover:text-accent transition-colors truncate">
          {session.displayName}
        </span>
        <Badge variant="muted">{session.agentId}</Badge>
        <span className="ml-auto text-xs text-ink-faint shrink-0">
          {formatRelativeTime(session.updatedAt)}
        </span>
      </div>

      {/* Summary line */}
      {summary && (
        <p className="text-xs text-ink-muted leading-relaxed mb-1.5 pl-[3.25rem]">
          {summary}
        </p>
      )}

      {/* Stats row */}
      <div className="flex items-center gap-4 pl-[3.25rem] text-[11px] text-ink-faint">
        <span className="flex items-center gap-1">
          <MessageSquare className="w-3 h-3" />
          {formatNumber(session.messageCount)} msgs
        </span>
        {session.toolCallCount > 0 && (
          <span className="flex items-center gap-1">
            <Wrench className="w-3 h-3" />
            {formatNumber(session.toolCallCount)} tools
          </span>
        )}
        {session.totalCost > 0 && (
          <span className="flex items-center gap-1">
            <DollarSign className="w-3 h-3" />
            {formatCost(session.totalCost)}
          </span>
        )}
        {session.runCount > 1 && (
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {session.runCount} runs
          </span>
        )}
        {session.durationMs != null && session.durationMs > 0 && (
          <span className="font-mono">
            {formatDuration(session.durationMs)}
          </span>
        )}
      </div>
    </Link>
  );
}
