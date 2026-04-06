import { useState } from "react";
import { useHealth, useSummary, useCosts, useSessions, useSecurityLatest, apiPost, type HealResult } from "@/lib/api";
import { AgentSetupCard } from "@/components/dashboard/AgentSetupCard";
import { Badge, ChannelBadge, StatusDot } from "@/components/ui/badge";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  formatKb,
  formatNumber,
  formatCost,
  formatDuration,
  formatRelativeTime,
  formatSessionName,
  truncate,
} from "@/lib/utils";
import {
  Activity,
  MessageSquare,
  Wrench,
  Sparkles,
  DollarSign,
  TrendingUp,
  TrendingDown,
  Minus,
  Shield,
  Heart,
} from "lucide-react";
import { Link } from "react-router";

export function Dashboard() {
  const [healing, setHealing] = useState(false);
  const [healResult, setHealResult] = useState<HealResult | null>(null);
  const { data: health, error: healthErr, mutate: retryHealth } = useHealth();
  const { data: summary, error: summaryErr, mutate: retrySummary } = useSummary();
  const { data: costs } = useCosts();
  const { data: sessionsData } = useSessions();
  const { data: securityReport } = useSecurityLatest();

  const sessionLookup = new Map(
    sessionsData?.items.map((s) => [s.sessionKey, { sessionId: s.sessionId, agentId: s.agentId }]) ?? [],
  );

  if (healthErr && summaryErr) {
    return <ErrorState message="Failed to load dashboard data" onRetry={() => { retryHealth(); retrySummary(); }} />;
  }

  if (!health && !summary) return <PageSkeleton />;

  const s = summary?.last24h;

  // Cost trend
  const byDay = costs?.byDay ?? [];
  const costTrend = byDay.length >= 2
    ? byDay[byDay.length - 1].total_cost - byDay[byDay.length - 2].total_cost
    : 0;

  return (
    <div className="space-y-5">
      <AgentSetupCard
        onOpenChat={(prefill) => {
          window.dispatchEvent(
            new CustomEvent("openclaw:open-chat", { detail: { prefill } }),
          );
        }}
      />

      {/* ── Metrics + Health — single left-aligned strip ── */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <Metric icon={<Activity className="w-3.5 h-3.5" />} label="Runs" value={s ? formatNumber(s.runs_24h) : "--"} />
        <Metric icon={<MessageSquare className="w-3.5 h-3.5" />} label="Messages" value={s ? formatNumber(s.messages_24h) : "--"} />
        <Metric icon={<Wrench className="w-3.5 h-3.5" />} label="Tools" value={s ? formatNumber(s.tool_calls_24h) : "--"} />
        <Metric icon={<Sparkles className="w-3.5 h-3.5" />} label="Skills" value={s ? formatNumber(s.skill_triggers_24h) : "--"} />
        <Metric
          icon={<DollarSign className="w-3.5 h-3.5" />}
          label="Cost"
          value={costs ? formatCost(costs.summary.cost_24h) : "--"}
          trend={costTrend}
        />
        {securityReport && (
          <Link to="/security" className="flex items-baseline gap-1.5 hover:opacity-80 transition-opacity">
            <span className="text-ink-faint self-center"><Shield className="w-3.5 h-3.5" /></span>
            <span className="text-xs text-ink-muted">Security</span>
            <span className={`text-lg font-semibold font-mono tabular-nums leading-none ${
              securityReport.score >= 80 ? "text-healthy" : securityReport.score >= 50 ? "text-warning" : "text-error"
            }`}>
              {securityReport.score}
            </span>
          </Link>
        )}
        {health && (
          <>
            <span className="text-border select-none">|</span>
            <InlineGauge
              label="CPU"
              value={health.cpu.load1.toFixed(1)}
              sub={`/${health.cpu.cores}`}
              percent={(health.cpu.load1 / health.cpu.cores) * 100}
            />
            <InlineGauge
              label="MEM"
              value={formatKb(health.memory.usedKb)}
              sub={`/${formatKb(health.memory.totalKb)}`}
              percent={health.memory.usedPercent}
            />
            <InlineGauge
              label="DISK"
              value={formatKb(health.disk.usedKb)}
              sub={`/${formatKb(health.disk.sizeKb)}`}
              percent={health.disk.usePercent}
            />
          </>
        )}
      </div>

      {/* ── Self-heal button ── */}
      <div className="flex items-center gap-3">
        <button
          onClick={async () => {
            setHealing(true);
            setHealResult(null);
            try {
              const result = await apiPost<HealResult>("/api/system/heal", { target: "all", dryRun: false });
              setHealResult(result);
            } catch { /* ignore */ } finally {
              setHealing(false);
              retryHealth();
            }
          }}
          disabled={healing}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-card border border-border text-ink rounded-lg hover:bg-cream-dark/40 disabled:opacity-50 transition-colors"
        >
          <Heart className={`w-3 h-3 ${healing ? "animate-pulse text-error" : "text-ink-faint"}`} />
          {healing ? "Healing..." : "Self-Heal"}
        </button>
        {healResult && (
          <span className={`text-xs ${healResult.success ? "text-healthy" : "text-error"}`}>
            {healResult.fixedCount > 0 && `${healResult.fixedCount} fixed`}
            {healResult.brokenCount > 0 && ` ${healResult.brokenCount} broken`}
            {healResult.fixedCount === 0 && healResult.brokenCount === 0 && "All clear"}
          </span>
        )}
      </div>

      <div className="h-px bg-border" />

      {/* ── Breakdowns: Agent + Channel side by side ── */}
      {summary && (summary.byAgent.length > 0 || summary.byChannel.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {summary.byAgent.length > 0 && (
            <div>
              <SectionLabel>Runs by Agent (24h)</SectionLabel>
              <div className="mt-2 space-y-1.5">
                {summary.byAgent.slice(0, 6).map((a) => {
                  const maxRuns = Math.max(...summary.byAgent.map((x) => x.runs));
                  return (
                    <div key={a.agent_id} className="flex items-center gap-2">
                      <span className="text-xs text-ink-muted w-16 truncate shrink-0">{a.agent_id}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-cream-dark overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent-muted"
                          style={{ width: `${(a.runs / maxRuns) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono text-ink-faint w-6 text-right">{a.runs}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {summary.byChannel.length > 0 && (
            <div>
              <SectionLabel>Runs by Channel (24h)</SectionLabel>
              <div className="mt-2 space-y-1.5">
                {summary.byChannel.map((ch) => {
                  const maxRuns = Math.max(...summary.byChannel.map((x) => x.runs));
                  return (
                    <div key={`${ch.channel}-${ch.source}`} className="flex items-center gap-2">
                      <span className="text-xs text-ink-muted w-16 truncate shrink-0">{ch.channel}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-cream-dark overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(ch.runs / maxRuns) * 100}%`,
                            background: `var(--color-channel-${ch.channel}, var(--color-ink-faint))`,
                          }}
                        />
                      </div>
                      <span className="text-xs font-mono text-ink-faint w-6 text-right">{ch.runs}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Recent runs with summaries ── */}
      <div>
        <SectionLabel>Recent Runs</SectionLabel>
        {summary?.recentRuns.length === 0 && (
          <p className="text-xs text-ink-faint mt-2">No recent runs</p>
        )}
        <div className="mt-2 divide-y divide-border/60">
          {summary?.recentRuns.map((run) => {
            const resolved = sessionLookup.get(run.session_key);
            const name = formatSessionName(run.session_key, run.channel);
            const isRunning = !run.ended_at;
            const summary = run.first_user_message
              ? truncate(run.first_user_message.replace(/\n/g, " ").trim(), 90)
              : null;

            const inner = (
              <div className="py-2 px-2 -mx-2 rounded-lg hover:bg-cream-dark/50 transition-colors group">
                <div className="flex items-center gap-2.5">
                  {/* Status dot */}
                  <span className="shrink-0">
                    {isRunning ? (
                      <StatusDot status="healthy" />
                    ) : (
                      <span className="block w-1.5 h-1.5 rounded-full bg-ink-faint/50" />
                    )}
                  </span>

                  {/* Channel + Agent */}
                  <ChannelBadge channel={run.channel} />
                  <Badge variant="muted">{run.agent_id}</Badge>

                  {/* Summary or session name */}
                  <span className="text-sm text-ink truncate min-w-0">
                    {summary ?? name}
                  </span>

                  {/* Right side */}
                  <div className="ml-auto flex items-center gap-3 text-xs text-ink-faint shrink-0">
                    {run.duration_ms != null && (
                      <span className="font-mono">{formatDuration(run.duration_ms)}</span>
                    )}
                    {isRunning && (
                      <span className="text-healthy font-medium">running</span>
                    )}
                    <span className="text-ink-faint/70">{formatRelativeTime(run.started_at)}</span>
                  </div>
                </div>
              </div>
            );

            return resolved ? (
              <Link key={run.run_id} to={`/activity/${resolved.agentId}/${encodeURIComponent(resolved.sessionId)}/${run.run_id}`}>
                {inner}
              </Link>
            ) : (
              <div key={run.run_id}>{inner}</div>
            );
          })}
        </div>
      </div>

      {/* ── Footer: totals + cost ── */}
      <div className="h-px bg-border" />
      <div className="flex flex-wrap gap-x-8 gap-y-1 text-xs text-ink-faint">
        <span>Sessions: <strong className="text-ink-muted font-mono">{summary ? formatNumber(summary.totalSessions) : "--"}</strong></span>
        <span>Messages: <strong className="text-ink-muted font-mono">{summary ? formatNumber(summary.totalMessages) : "--"}</strong></span>
        <span>Events: <strong className="text-ink-muted font-mono">{summary ? formatNumber(summary.totalEvents) : "--"}</strong></span>
        {costs && <span>Total cost: <strong className="text-ink-muted font-mono">{formatCost(costs.summary.total_cost)}</strong></span>}
        {costs && <span>7d cost: <strong className="text-ink-muted font-mono">{formatCost(costs.summary.cost_7d)}</strong></span>}
      </div>
    </div>
  );
}

/* ── Sub-components ── */

function Metric({ icon, label, value, trend }: {
  icon: React.ReactNode; label: string; value: string; trend?: number;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-ink-faint self-center">{icon}</span>
      <span className="text-xs text-ink-muted">{label}</span>
      <span className="text-lg font-semibold text-ink font-mono tabular-nums leading-none">{value}</span>
      {trend != null && trend !== 0 && (
        <span className={`flex items-center gap-0.5 text-xs ${trend > 0 ? "text-warning" : "text-healthy"}`}>
          {trend > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
        </span>
      )}
      {trend != null && trend === 0 && (
        <Minus className="w-3 h-3 text-ink-faint" />
      )}
    </div>
  );
}

function InlineGauge({ label, value, sub, percent }: {
  label: string; value: string; sub: string; percent: number;
}) {
  const color = percent < 70 ? "bg-healthy" : percent < 90 ? "bg-warning" : "bg-error";
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-ink-faint font-medium w-8">{label}</span>
      <div className="w-16 h-1 rounded-full bg-cream-dark overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <span className="text-xs font-mono text-ink-muted tabular-nums">
        {value}<span className="text-ink-faint">{sub}</span>
      </span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider">{children}</h3>
  );
}
