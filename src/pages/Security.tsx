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
  Shield,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  FileKey,
  Lock,
  UserCheck,
  Layers,
  RefreshCw,
  Save,
} from "lucide-react";

const gradeColors: Record<string, string> = {
  A: "text-healthy",
  B: "text-healthy",
  C: "text-warning",
  D: "text-error",
  F: "text-error",
};

const gradeBgColors: Record<string, string> = {
  A: "bg-healthy/10",
  B: "bg-healthy/10",
  C: "bg-warning/10",
  D: "bg-error/10",
  F: "bg-error/10",
};

export function Security() {
  const { data: latest, error, mutate } = useSecurityLatest();
  const { data: history } = useSecurityHistory();
  const [scanning, setScanning] = useState(false);
  const [settingBaseline, setSettingBaseline] = useState(false);

  async function runScan() {
    setScanning(true);
    try {
      await apiPost("/api/security/scan");
      await mutate();
    } catch {
      // error handled by SWR
    } finally {
      setScanning(false);
    }
  }

  async function setBaseline() {
    setSettingBaseline(true);
    try {
      await apiPost("/api/security/baseline");
      await mutate();
    } catch {
      // error handled by SWR
    } finally {
      setSettingBaseline(false);
    }
  }

  if (error) return <ErrorState message="Failed to load security data" onRetry={() => mutate()} />;
  if (latest === undefined) return <PageSkeleton />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Security"
        description="Compliance scoring, credential scanning, and skill integrity monitoring"
      />

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={runScan}
          disabled={scanning}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", scanning && "animate-spin")} />
          {scanning ? "Scanning..." : "Run Scan"}
        </button>
        <button
          onClick={setBaseline}
          disabled={settingBaseline}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-card border border-border text-ink rounded-lg hover:bg-cream-dark/40 disabled:opacity-50 transition-colors"
        >
          <Save className="w-3.5 h-3.5" />
          {settingBaseline ? "Saving..." : "Set Skill Baseline"}
        </button>
      </div>

      {latest === null ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center">
          <Shield className="w-8 h-8 text-ink-faint mx-auto mb-3" />
          <p className="text-sm text-ink-muted">No security scan has been run yet.</p>
          <p className="text-xs text-ink-faint mt-1">Click "Run Scan" to generate your first compliance report.</p>
        </div>
      ) : (
        <>
          {/* Score + Grade */}
          <ScoreCard report={latest} />

          {/* Breakdown */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <CategoryCard
              icon={<Lock className="w-4 h-4" />}
              title="Exec Posture"
              category={latest.breakdown.execPosture}
            />
            <CategoryCard
              icon={<FileKey className="w-4 h-4" />}
              title="Credential Exposure"
              category={latest.breakdown.credentialExposure}
            />
            <CategoryCard
              icon={<Layers className="w-4 h-4" />}
              title="Skill Integrity"
              category={latest.breakdown.skillIntegrity}
            />
            <CategoryCard
              icon={<UserCheck className="w-4 h-4" />}
              title="Auth Health"
              category={latest.breakdown.authHealth}
            />
          </div>

          {/* Credential findings */}
          {latest.breakdown.credentialExposure.findings.length > 0 && (
            <FindingsTable findings={latest.breakdown.credentialExposure.findings} />
          )}

          {/* Skill drift */}
          <SkillDriftSection drift={latest.breakdown.skillIntegrity} />

          {/* History */}
          {history && history.items.length > 1 && (
            <HistorySection items={history.items} />
          )}
        </>
      )}
    </div>
  );
}

function ScoreCard({ report }: { report: SecurityComplianceReport }) {
  const GradeIcon = report.score >= 80 ? ShieldCheck : ShieldAlert;

  return (
    <div className={cn("bg-card rounded-xl border border-border p-6 flex items-center gap-6", gradeBgColors[report.grade])}>
      <div className={cn("flex items-center justify-center w-16 h-16 rounded-full border-2", gradeColors[report.grade])}>
        <GradeIcon className="w-8 h-8" />
      </div>
      <div>
        <div className="flex items-baseline gap-3">
          <span className={cn("text-4xl font-bold tabular-nums", gradeColors[report.grade])}>
            {report.score}
          </span>
          <span className="text-lg text-ink-muted">/100</span>
          <span className={cn("text-2xl font-bold", gradeColors[report.grade])}>
            {report.grade}
          </span>
        </div>
        <p className="text-xs text-ink-faint mt-1">
          Last scanned {formatRelativeTime(report.scannedAt)}
        </p>
      </div>
    </div>
  );
}

function CategoryCard({
  icon,
  title,
  category,
}: {
  icon: React.ReactNode;
  title: string;
  category: SecurityCategoryScore;
}) {
  const pct = (category.score / category.max) * 100;
  const color = pct >= 80 ? "bg-healthy" : pct >= 50 ? "bg-warning" : "bg-error";
  const textColor = pct >= 80 ? "text-healthy" : pct >= 50 ? "text-warning" : "text-error";

  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-ink-faint">{icon}</span>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <span className={cn("ml-auto text-sm font-bold tabular-nums", textColor)}>
          {category.score}/{category.max}
        </span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-cream-dark overflow-hidden mb-3">
        <div
          className={cn("h-full rounded-full transition-all duration-500", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <ul className="space-y-1">
        {category.details.map((detail, i) => (
          <li key={i} className="text-xs text-ink-muted leading-relaxed">{detail}</li>
        ))}
      </ul>
    </div>
  );
}

function FindingsTable({ findings }: { findings: SecurityCredentialCategory["findings"] }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-error mb-2 flex items-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5" />
        Credential Findings ({findings.length})
      </h3>
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="grid grid-cols-[120px_1fr] gap-3 px-4 py-2 border-b border-border text-[10px] uppercase tracking-wider text-ink-faint">
          <span>Pattern</span>
          <span>Context</span>
        </div>
        {findings.slice(0, 20).map((f, i) => (
          <div
            key={i}
            className="grid grid-cols-[120px_1fr] gap-3 px-4 py-2 border-b border-border/40 last:border-b-0"
          >
            <span className="text-xs font-mono text-error">{f.label}</span>
            <span className="text-xs font-mono text-ink-muted truncate">{f.snippet}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SkillDriftSection({ drift }: { drift: SecuritySkillDriftCategory }) {
  const hasChanges = drift.added.length > 0 || drift.removed.length > 0 || drift.modified.length > 0;
  if (drift.baselineCount === 0 && !hasChanges) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-ink mb-2 flex items-center gap-2">
        <Layers className="w-3.5 h-3.5 text-ink-faint" />
        Skill Drift
        {!hasChanges && <span className="text-xs font-normal text-healthy">(no drift)</span>}
      </h3>
      {hasChanges ? (
        <div className="bg-card rounded-xl border border-border p-4 space-y-2">
          {drift.added.map((f) => (
            <div key={f} className="text-xs">
              <span className="text-healthy font-medium">NEW</span>{" "}
              <span className="font-mono text-ink-muted">{f}</span>
            </div>
          ))}
          {drift.modified.map((f) => (
            <div key={f} className="text-xs">
              <span className="text-warning font-medium">MODIFIED</span>{" "}
              <span className="font-mono text-ink-muted">{f}</span>
            </div>
          ))}
          {drift.removed.map((f) => (
            <div key={f} className="text-xs">
              <span className="text-error font-medium">REMOVED</span>{" "}
              <span className="font-mono text-ink-muted">{f}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-ink-faint">
          Baseline: {drift.baselineCount} files. Current: {drift.currentCount} files.
        </p>
      )}
    </div>
  );
}

function HistorySection({ items }: { items: Array<{ id: number; score: number; scanned_at: string }> }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-ink mb-2">Scan History</h3>
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        {items.slice(0, 20).map((item) => {
          const color = item.score >= 80 ? "text-healthy" : item.score >= 50 ? "text-warning" : "text-error";
          return (
            <div
              key={item.id}
              className="flex items-center gap-4 px-4 py-2 border-b border-border/40 last:border-b-0"
            >
              <span className={cn("text-sm font-bold tabular-nums w-12", color)}>{item.score}</span>
              <div className="flex-1 h-1 rounded-full bg-cream-dark overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full",
                    item.score >= 80 ? "bg-healthy" : item.score >= 50 ? "bg-warning" : "bg-error",
                  )}
                  style={{ width: `${item.score}%` }}
                />
              </div>
              <span className="text-xs text-ink-faint">{formatRelativeTime(item.scanned_at)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
