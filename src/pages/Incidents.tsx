import { Link } from "react-router";

import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/error-state";
import { PageSkeleton } from "@/components/ui/skeleton";
import { useIncidents, type IncidentSeverity, type IncidentStatus } from "@/lib/api";
import { cn, formatLocal, formatRelativeTime } from "@/lib/utils";

const severityClass: Record<IncidentSeverity, string> = {
  critical: "text-error",
  warning: "text-warning",
  info: "text-ink-muted",
};

const statusClass: Record<IncidentStatus, string> = {
  open: "text-error",
  acknowledged: "text-warning",
  resolved: "text-healthy",
};

export function Incidents() {
  const { data, error, mutate } = useIncidents();

  if (error) {
    return <ErrorState message="Failed to load incidents" onRetry={() => mutate()} />;
  }

  if (!data) {
    return <PageSkeleton />;
  }

  const incidents = data.items;

  return (
    <div className="space-y-5">
      <PageHeader title="Incidents" description={`${incidents.length} tracked incidents`} />

      <div className="grid grid-cols-3 gap-3">
        <SummaryCard
          label="Open"
          value={incidents.filter((item) => item.status === "open").length}
          tone="text-error"
        />
        <SummaryCard
          label="Acknowledged"
          value={incidents.filter((item) => item.status === "acknowledged").length}
          tone="text-warning"
        />
        <SummaryCard
          label="Resolved"
          value={incidents.filter((item) => item.status === "resolved").length}
          tone="text-healthy"
        />
      </div>

      <div className="bg-card rounded-xl overflow-hidden">
        <div className="grid grid-cols-[90px_1.5fr_120px_120px_120px_88px] gap-3 px-4 py-2 border-b border-border text-[10px] uppercase tracking-wider text-ink-faint">
          <span>Severity</span>
          <span>Incident</span>
          <span>State</span>
          <span>Opened</span>
          <span>Last Seen</span>
          <span>Events</span>
        </div>

        {incidents.length === 0 && (
          <div className="px-4 py-8 text-sm text-ink-muted text-center">No incidents recorded yet.</div>
        )}

        {incidents.map((incident) => {
          const isResolved = incident.status === "resolved";
          return (
            <Link
              key={incident.id}
              to={`/incidents/${incident.id}`}
              className={cn(
                "grid grid-cols-[90px_1.5fr_120px_120px_120px_88px] gap-3 px-4 py-3 border-b border-border/50 transition-colors",
                isResolved ? "opacity-45 hover:opacity-70" : "hover:bg-cream-dark/40",
              )}
            >
              <span
                className={cn(
                  "text-xs font-semibold uppercase",
                  isResolved ? "text-ink-muted" : severityClass[incident.severity],
                )}
              >
                {incident.severity}
              </span>
              <div className="min-w-0">
                <div className={cn("text-sm font-medium truncate", isResolved ? "text-ink-muted" : "text-ink")}>
                  {incident.title}
                </div>
                <div className="text-xs text-ink-muted truncate">{incident.summary}</div>
              </div>
              <span className={cn("text-xs font-medium capitalize", statusClass[incident.status])}>
                {incident.status}
              </span>
              <span className="text-xs text-ink-muted" title={formatLocal(incident.opened_at)}>
                {formatRelativeTime(incident.opened_at)}
              </span>
              <span className="text-xs text-ink-muted" title={formatLocal(incident.last_seen_at)}>
                {formatRelativeTime(incident.last_seen_at)}
              </span>
              <span className="text-xs text-ink-muted">{incident.event_count}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="bg-card rounded-xl px-4 py-3 border border-border/50">
      <div className="text-[11px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold", tone)}>{value}</div>
    </div>
  );
}
