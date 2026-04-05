import { useState } from "react";

import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorState } from "@/components/ui/error-state";
import { PageSkeleton } from "@/components/ui/skeleton";
import {
  useSecurityLatest,
  useSecurityHistory,
  apiPost,
  type SecurityComplianceReport,
  type SecurityCategoryScore,
  type SecurityCredentialCategory,
  type SecuritySkillDriftCategory,
} from "@/lib/api";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  RefreshCw,
  Check,
  X,
  Minus,
} from "lucide-react";

export function Security() {
  const { data: latest, error, mutate } = useSecurityLatest();
  const { data: history } = useSecurityHistory();
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function runScan() {
    setScanning(true);
    try {
      await apiPost("/api/security/scan");
      await mutate();
      setToast("Scan complete");
    } catch {
      setToast("Scan failed");
    } finally {
      setScanning(false);
      setTimeout(() => setToast(null), 3000);
    }
  }

  if (error) return <ErrorState message="Failed to load security data" onRetry={() => mutate()} />;
  if (latest === undefined) return <PageSkeleton />;

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Security"
        description="How well is your OpenClaw instance locked down?"
      />

      {/* Scan button + toast */}
      <div className="flex items-center gap-3">
        <button
          onClick={runScan}
          disabled={scanning}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", scanning && "animate-spin")} />
          {scanning ? "Scanning..." : "Run Scan"}
        </button>
        {toast && (
          <span className="text-xs text-ink-muted animate-in fade-in">{toast}</span>
        )}
      </div>

      {latest === null ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center">
          <ShieldAlert className="w-8 h-8 text-ink-faint mx-auto mb-3" />
          <p className="text-sm text-ink-muted">No scan yet. Click "Run Scan" to check your setup.</p>
        </div>
      ) : (
        <>
          {/* Score */}
          <ScoreHeader report={latest} />

          {/* Checklist */}
          <div className="bg-card rounded-xl border border-border divide-y divide-border/40">
            <ChecklistRow
              label="Exec security"
              sublabel="Can agents run commands safely?"
              category={latest.breakdown.execPosture}
            />
            <ChecklistRow
              label="Secret exposure"
              sublabel="Any API keys leaked in tool outputs?"
              category={latest.breakdown.credentialExposure}
            />
            <ChecklistRow
              label="Skill files"
              sublabel="Have installed skills been tampered with?"
              category={latest.breakdown.skillIntegrity}
            />
            <ChecklistRow
              label="Auth profiles"
              sublabel="Are API keys configured and valid?"
              category={latest.breakdown.authHealth}
            />
          </div>

          {/* Findings — only show if there are problems */}
          {latest.breakdown.credentialExposure.findings.length > 0 && (
            <FindingsSection findings={latest.breakdown.credentialExposure.findings} />
          )}

          {/* Skill drift — only show if there are changes */}
          <SkillDriftSection drift={latest.breakdown.skillIntegrity} />

          {/* History sparkline */}
          {history && history.items.length > 1 && (
            <HistoryStrip items={history.items} />
          )}
        </>
      )}
    </div>
  );
}

function ScoreHeader({ report }: { report: SecurityComplianceReport }) {
  const good = report.score >= 80;
  const Icon = good ? ShieldCheck : ShieldAlert;

  return (
    <div className={cn(
      "flex items-center gap-5 rounded-xl border p-5",
      good ? "bg-healthy/5 border-healthy/20" : "bg-error/5 border-error/20",
    )}>
      <Icon className={cn("w-10 h-10 shrink-0", good ? "text-healthy" : "text-error")} />
      <div>
        <div className="flex items-baseline gap-2">
          <span className={cn("text-3xl font-bold tabular-nums", good ? "text-healthy" : "text-error")}>
            {report.score}
          </span>
          <span className="text-sm text-ink-muted">/100</span>
        </div>
        <p className="text-xs text-ink-faint mt-0.5">
          {good
            ? "Your instance is well configured."
            : "Some settings need attention."}
          {" "}Scanned {formatRelativeTime(report.scannedAt)}.
        </p>
      </div>
    </div>
  );
}

function ChecklistRow({
  label,
  sublabel,
  category,
}: {
  label: string;
  sublabel: string;
  category: SecurityCategoryScore;
}) {
  const pct = (category.score / category.max) * 100;
  const perfect = pct === 100;
  const bad = pct < 50;

  const StatusIcon = perfect ? Check : bad ? X : Minus;
  const statusColor = perfect ? "text-healthy" : bad ? "text-error" : "text-warning";

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <StatusIcon className={cn("w-4 h-4 shrink-0", statusColor)} />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-ink">{label}</span>
          <span className="text-xs text-ink-faint ml-2">{sublabel}</span>
        </div>
        <span className={cn("text-xs font-bold tabular-nums", statusColor)}>
          {category.score}/{category.max}
        </span>
      </div>
      {/* Show details only when not perfect */}
      {!perfect && category.details.length > 0 && (
        <div className="mt-2 ml-7 space-y-0.5">
          {category.details.map((d, i) => (
            <p key={i} className="text-xs text-ink-muted">{d}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function FindingsSection({ findings }: { findings: SecurityCredentialCategory["findings"] }) {
  return (
    <div className="bg-error/5 rounded-xl border border-error/20 p-4">
      <h3 className="text-sm font-semibold text-error flex items-center gap-2 mb-2">
        <AlertTriangle className="w-3.5 h-3.5" />
        Secrets found in tool outputs ({findings.length})
      </h3>
      <p className="text-xs text-ink-muted mb-3">
        These patterns were detected in recent tool call outputs. They may be real credentials that agents are exposing.
      </p>
      <div className="space-y-1">
        {findings.slice(0, 10).map((f, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="font-mono text-error shrink-0">{f.label}</span>
            <span className="font-mono text-ink-faint truncate">{f.snippet}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SkillDriftSection({ drift }: { drift: SecuritySkillDriftCategory }) {
  const hasChanges = drift.added.length > 0 || drift.removed.length > 0 || drift.modified.length > 0;
  if (!hasChanges) return null;

  return (
    <div className="bg-warning/5 rounded-xl border border-warning/20 p-4">
      <h3 className="text-sm font-semibold text-warning mb-2">
        Skill files changed since baseline
      </h3>
      <p className="text-xs text-ink-muted mb-3">
        These skill files differ from the last saved snapshot. This could mean a skill was updated, or something was modified unexpectedly.
      </p>
      <div className="space-y-1">
        {drift.added.map((f) => (
          <div key={f} className="text-xs"><span className="text-healthy font-medium">added</span> <span className="font-mono text-ink-muted">{f}</span></div>
        ))}
        {drift.modified.map((f) => (
          <div key={f} className="text-xs"><span className="text-warning font-medium">changed</span> <span className="font-mono text-ink-muted">{f}</span></div>
        ))}
        {drift.removed.map((f) => (
          <div key={f} className="text-xs"><span className="text-error font-medium">removed</span> <span className="font-mono text-ink-muted">{f}</span></div>
        ))}
      </div>
    </div>
  );
}

function HistoryStrip({ items }: { items: Array<{ id: number; score: number; scanned_at: string }> }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-2">Recent scans</h3>
      <div className="flex items-end gap-1 h-8">
        {items.slice(0, 30).reverse().map((item) => {
          const color = item.score >= 80 ? "bg-healthy" : item.score >= 50 ? "bg-warning" : "bg-error";
          return (
            <div
              key={item.id}
              className={cn("flex-1 rounded-sm min-w-1 transition-all", color)}
              style={{ height: `${Math.max(10, item.score)}%` }}
              title={`${item.score}/100 — ${formatRelativeTime(item.scanned_at)}`}
            />
          );
        })}
      </div>
    </div>
  );
}
