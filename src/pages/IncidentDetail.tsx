import { Link, useParams } from "react-router";

import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/error-state";
import { PageSkeleton } from "@/components/ui/skeleton";
import { useIncidentDetail, type IncidentSeverity } from "@/lib/api";
import { cn, formatLocal, formatRelativeTime } from "@/lib/utils";

const severityClass: Record<IncidentSeverity, string> = {
  critical: "text-error",
  warning: "text-warning",
  info: "text-ink-muted",
};

export function IncidentDetail() {
  const { incidentId } = useParams();
  const { data, error, mutate } = useIncidentDetail(incidentId ?? null);

  if (error) {
    return <ErrorState message="Failed to load incident detail" onRetry={() => mutate()} />;
  }

  if (!data) {
    return <PageSkeleton />;
  }

  const { incident, events, recentResults } = data;

  return (
    <div className="space-y-5">
      <PageHeader
        title={incident.title}
        description={incident.summary}
        actions={<Link to="/incidents" className="text-xs text-accent hover:underline">Back to incidents</Link>}
      />

      <div className="grid lg:grid-cols-[1.1fr_0.9fr] gap-5">
        <section className="bg-card rounded-xl p-4 border border-border/50 space-y-4">
          <div className="flex flex-wrap gap-4 text-sm">
            <Meta label="Severity" value={incident.severity} tone={severityClass[incident.severity]} />
            <Meta label="State" value={incident.status} />
            <Meta label="Check" value={incident.check_type} />
            <Meta label="Target" value={incident.target_key} />
          </div>

          <div className="grid sm:grid-cols-3 gap-3 text-sm">
            <TimeCard label="Opened" value={incident.opened_at} />
            <TimeCard label="Last seen" value={incident.last_seen_at} />
            <TimeCard label="Resolved" value={incident.resolved_at} empty="Still open" />
          </div>

          <div>
            <h2 className="text-sm font-medium text-ink">Recent check results</h2>
            <div className="mt-3 space-y-3">
              {recentResults.map((result) => (
                <div key={result.id} className="rounded-lg border border-border/60 p-3 bg-cream/40">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm text-ink font-medium">{result.summary}</div>
                    <div className="text-xs text-ink-muted">{formatRelativeTime(result.observed_at)}</div>
                  </div>
                  <div className="mt-2 text-xs text-ink-faint">
                    {result.check_type} / {result.target_key} / {result.status}
                  </div>
                  <pre className="mt-3 text-xs text-ink-muted bg-sidebar/40 rounded-lg p-3 overflow-x-auto">
                    {JSON.stringify(result.evidence, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-card rounded-xl p-4 border border-border/50">
          <h2 className="text-sm font-medium text-ink">Incident timeline</h2>
          <div className="mt-3 space-y-3">
            {events.map((event) => (
              <div key={event.id} className="border-l-2 border-border pl-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm text-ink font-medium capitalize">{event.event_type}</div>
                  <div className="text-xs text-ink-muted" title={formatLocal(event.created_at)}>
                    {formatRelativeTime(event.created_at)}
                  </div>
                </div>
                <pre className="mt-2 text-xs text-ink-muted bg-cream/40 rounded-lg p-3 overflow-x-auto">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function Meta({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div className={cn("text-sm font-medium capitalize", tone)}>{value}</div>
    </div>
  );
}

function TimeCard({ label, value, empty = "-", }: { label: string; value: string | null; empty?: string }) {
  return (
    <div className="rounded-lg bg-cream/40 p-3">
      <div className="text-[11px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div className="mt-1 text-sm text-ink">{value ? formatLocal(value) : empty}</div>
    </div>
  );
}
