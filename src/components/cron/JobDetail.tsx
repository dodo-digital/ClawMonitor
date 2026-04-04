import { useState } from "react";
import { X, Clock, Terminal, FileText, Activity, BarChart3, Save, ChevronRight, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useCronJob, useCronJobConfig, useCronJobSession, updateCronJobConfig, type RegistryJob, type RunEntry, type RunStats } from "@/lib/api";
import { formatDuration, formatRelativeTime, formatLocal, humanCron, cn } from "@/lib/utils";
import { RunTranscript } from "./RunTranscript";
import { SessionTrace } from "./SessionTrace";

type JobDetailProps = {
  jobId: string;
  onClose: () => void;
  onToggle: () => void;
};

const statusVariant: Record<string, "healthy" | "error" | "warning" | "muted"> = {
  healthy: "healthy",
  failing: "error",
  disabled: "muted",
  unknown: "warning",
};

export function JobDetail({ jobId, onClose, onToggle }: JobDetailProps) {
  const { data: job, error } = useCronJob(jobId);
  const [activeTab, setActiveTab] = useState<"detail" | "runs" | "session">("detail");

  if (error) {
    return (
      <SlideOut onClose={onClose}>
        <div className="p-6 text-sm text-error">Failed to load job details</div>
      </SlideOut>
    );
  }

  if (!job) {
    return (
      <SlideOut onClose={onClose}>
        <div className="p-6 space-y-3">
          <div className="skeleton h-6 w-48" />
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-3/4" />
          <div className="skeleton h-32 w-full" />
        </div>
      </SlideOut>
    );
  }

  const tabs = [
    { id: "detail" as const, label: "Details" },
    { id: "runs" as const, label: `Runs (${job.runs?.length ?? 0})` },
    ...(job.layer === "openclaw" ? [{ id: "session" as const, label: "Session" }] : []),
  ];

  return (
    <SlideOut onClose={onClose}>
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-border">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant={statusVariant[job.health?.status ?? "unknown"]}>
                {job.health?.status ?? "unknown"}
              </Badge>
              <Badge variant="muted">{job.layer}</Badge>
              <Badge variant="default">{job.category}</Badge>
            </div>
            <h2 className="text-lg font-semibold text-ink truncate">{job.name}</h2>
            {job.description && (
              <p className="text-sm text-ink-muted mt-1">{job.description}</p>
            )}
          </div>
          <button onClick={onClose} className="text-ink-muted hover:text-ink ml-4 mt-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Toggle + stats summary */}
        <div className="flex items-center gap-4 mt-3">
          <button
            onClick={onToggle}
            className={cn(
              "w-9 h-5 rounded-full transition-colors relative",
              job.enabled ? "bg-healthy" : "bg-cream-dark",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow-sm",
                job.enabled ? "left-4.5" : "left-0.5",
              )}
            />
          </button>
          <span className="text-sm text-ink-muted">{job.enabled ? "Enabled" : "Disabled"}</span>
        </div>
      </div>

      {/* Run stats banner */}
      {job.stats && job.stats.total > 0 && <StatsBanner stats={job.stats} />}

      {/* Tabs */}
      <div className="flex items-center gap-1 px-6 pt-3 pb-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
              activeTab === t.id ? "bg-accent text-white" : "text-ink-muted hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {activeTab === "detail" && <DetailTab job={job} />}
        {activeTab === "runs" && <RunsTab runs={job.runs} jobId={jobId} />}
        {activeTab === "session" && <SessionTab jobId={jobId} />}
      </div>
    </SlideOut>
  );
}

function StatsBanner({ stats }: { stats: RunStats }) {
  const rateColor = stats.successRate === 100
    ? "text-healthy"
    : stats.successRate >= 70
      ? "text-warning"
      : "text-error";

  return (
    <div className="px-6 py-3 bg-cream/60 border-b border-border/50">
      <div className="flex items-center gap-5">
        {/* Success rate — big number */}
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-ink-faint" />
          <span className={cn("text-xl font-bold tabular-nums", rateColor)}>
            {stats.successRate}%
          </span>
          <span className="text-[11px] text-ink-faint">success</span>
        </div>

        {/* Success bar */}
        <div className="flex-1 max-w-32">
          <div className="w-full h-2 rounded-full bg-cream-dark overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                stats.successRate === 100 ? "bg-healthy" : stats.successRate >= 70 ? "bg-warning" : "bg-error",
              )}
              style={{ width: `${stats.successRate}%` }}
            />
          </div>
        </div>

        {/* Breakdown */}
        <div className="flex items-center gap-3 text-[11px]">
          <span className="text-healthy font-medium">{stats.ok} ok</span>
          {stats.errors > 0 && <span className="text-error font-medium">{stats.errors} failed</span>}
          <span className="text-ink-faint">{stats.total} total</span>
        </div>

        {/* Last run */}
        {stats.lastRunAt && (
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-faint">
            <span className={cn(
              "w-[5px] h-[5px] rounded-full",
              stats.lastStatus === "ok" ? "bg-healthy" : "bg-error",
            )} />
            <span>Last: {formatLocal(stats.lastRunAt)}</span>
            {stats.lastDurationMs && (
              <span className="text-ink-faint">({formatDuration(stats.lastDurationMs)})</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SlideOut({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-overlay backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-card shadow-2xl flex flex-col animate-slide-in">
        {children}
      </div>
    </div>
  );
}

function DetailTab({ job }: { job: RegistryJob & { health: { status: string; details: string } } }) {
  const isOpenClaw = job.layer === "openclaw";
  const { data: config } = useCronJobConfig(isOpenClaw ? job.id : null);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");

  const prompt = config?.prompt ?? job.command;

  function startEditing() {
    setPromptText(prompt);
    setEditingPrompt(true);
    setSaveStatus("idle");
  }

  async function savePrompt() {
    setSaving(true);
    setSaveStatus("idle");
    try {
      await updateCronJobConfig(job.id, { prompt: promptText });
      setSaveStatus("saved");
      setEditingPrompt(false);
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <InfoBlock icon={Clock} label="Schedule">
        <div className="text-sm text-ink">{humanCron(job.schedule)}</div>
        {humanCron(job.schedule) !== job.schedule && (
          <code className="text-xs font-mono text-ink-faint mt-0.5 block">{job.schedule}</code>
        )}
      </InfoBlock>

      <InfoBlock icon={Terminal} label={isOpenClaw ? "Prompt" : "Command"}>
        {editingPrompt ? (
          <div className="space-y-2">
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              className="w-full text-xs font-mono text-ink bg-cream rounded-lg p-3 min-h-48 max-h-96 resize-y border border-border focus:border-accent focus:ring-1 focus:ring-accent outline-none"
              spellCheck={false}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={savePrompt}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white text-xs font-medium rounded-md hover:bg-accent/90 disabled:opacity-50 transition-colors"
              >
                <Save className="w-3 h-3" />
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={() => { setEditingPrompt(false); setSaveStatus("idle"); }}
                className="px-3 py-1.5 text-xs text-ink-muted hover:text-ink transition-colors"
              >
                Cancel
              </button>
              {saveStatus === "error" && <span className="text-xs text-error">Failed to save</span>}
            </div>
          </div>
        ) : (
          <div className="relative group">
            <pre className="text-xs font-mono text-ink whitespace-pre-wrap break-words bg-cream rounded-lg p-3 max-h-64 overflow-auto">
              {prompt}
            </pre>
            {isOpenClaw && (
              <button
                onClick={startEditing}
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 bg-accent text-white text-[10px] font-medium rounded"
              >
                Edit
              </button>
            )}
            {saveStatus === "saved" && <span className="absolute top-2 right-2 text-[10px] text-healthy font-medium">Saved</span>}
          </div>
        )}
      </InfoBlock>

      {/* Config metadata for OpenClaw jobs */}
      {config && (
        <InfoBlock icon={Activity} label="How this job runs">
          <div className="space-y-2.5 text-xs">
            <ConfigRow
              label={config.agentId === "direct" ? "Runs as the main agent" : `Runs as the "${config.agentId}" agent`}
              detail={config.agentId === "direct"
                ? "Uses the primary agent with full tool access and Telegram"
                : `Uses the ${config.agentId} agent configuration`}
            />
            <ConfigRow
              label={config.sessionTarget === "isolated" ? "Each run gets a fresh session" : "Runs in the main conversation"}
              detail={config.sessionTarget === "isolated"
                ? "No memory of previous runs — starts clean every time"
                : "Continues the agent's ongoing conversation thread"}
            />
            <ConfigRow
              label={config.delivery?.mode === "none" ? "No automatic delivery" : `Delivers via ${config.delivery?.mode}`}
              detail={config.delivery?.mode === "none"
                ? "Results stay in the workspace — the agent handles any messaging in its prompt"
                : `Output is automatically sent to ${config.delivery?.channel ?? "the configured channel"}`}
            />
            <ConfigRow
              label={config.timeoutSeconds ? `${Math.round(config.timeoutSeconds / 60)} minute time limit` : "Default time limit"}
              detail={config.timeoutSeconds
                ? `The agent has ${config.timeoutSeconds} seconds to complete before being stopped`
                : "Uses the system default timeout"}
            />
            {config.thinking && (
              <ConfigRow
                label={`Thinking: ${config.thinking}`}
                detail={config.thinking === "low" ? "Faster responses with less reasoning" : "More thorough reasoning before acting"}
              />
            )}
          </div>
        </InfoBlock>
      )}

      <InfoBlock icon={Activity} label="Health Check">
        <div className="text-sm text-ink-muted">{job.health.details}</div>
      </InfoBlock>

      {job.expects && (
        <InfoBlock icon={FileText} label="Expectations">
          <div className="space-y-1 text-xs font-mono text-ink-muted">
            {job.expects.exit_code !== undefined && <div>exit_code: {job.expects.exit_code}</div>}
            {job.expects.log_contains && <div>log_contains: "{job.expects.log_contains}"</div>}
            {job.expects.log_not_contains && <div>log_not_contains: "{job.expects.log_not_contains}"</div>}
          </div>
        </InfoBlock>
      )}

      {job.log && (
        <InfoBlock icon={FileText} label="Log File">
          <code className="text-xs font-mono text-ink-muted break-all">{job.log}</code>
        </InfoBlock>
      )}
    </div>
  );
}

function ConfigRow({ label, detail }: { label: string; detail: string }) {
  return (
    <div>
      <div className="text-ink font-medium">{label}</div>
      <div className="text-ink-faint text-[11px] mt-0.5">{detail}</div>
    </div>
  );
}

function InfoBlock({ icon: Icon, label, children }: { icon: React.ElementType; label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className="w-3.5 h-3.5 text-ink-faint" />
        <span className="text-xs font-medium text-ink-faint uppercase tracking-wider">{label}</span>
      </div>
      {children}
    </div>
  );
}

function RunsTab({ runs, jobId }: { runs: RunEntry[]; jobId: string }) {
  const [viewingRun, setViewingRun] = useState<RunEntry | null>(null);

  if (viewingRun?.sessionId) {
    return (
      <RunTranscript
        jobId={jobId}
        sessionId={viewingRun.sessionId}
        runSummary={viewingRun.summary}
        onBack={() => setViewingRun(null)}
      />
    );
  }

  if (!runs || runs.length === 0) {
    return <div className="text-sm text-ink-muted py-4">No run history available</div>;
  }

  return (
    <div className="space-y-1">
      {runs.map((run, i) => (
        <div
          key={`${run.ts}-${i}`}
          className={cn(
            "flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-cream/60 transition-colors",
            run.sessionId ? "cursor-pointer" : "",
          )}
          onClick={() => run.sessionId ? setViewingRun(run) : undefined}
        >
          <span
            className={cn(
              "w-2 h-2 rounded-full flex-shrink-0",
              run.status === "ok" ? "bg-healthy" : "bg-error",
            )}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink">
                {formatLocal(run.ts)}
              </span>
              <span className="text-[11px] text-ink-faint">
                {formatRelativeTime(new Date(run.ts).toISOString())}
              </span>
              {run.durationMs && (
                <span className="text-[11px] text-ink-faint">{formatDuration(run.durationMs)}</span>
              )}
            </div>
            {run.summary && (
              <p className="text-[11px] text-ink-muted mt-0.5 line-clamp-2">{run.summary}</p>
            )}
          </div>
          <Badge variant={run.status === "ok" ? "healthy" : "error"}>{run.status}</Badge>
          {run.sessionId && (
            <ChevronRight className="w-3.5 h-3.5 text-ink-faint flex-shrink-0" />
          )}
        </div>
      ))}
    </div>
  );
}

function SessionTab({ jobId }: { jobId: string }) {
  const { data, error } = useCronJobSession(jobId);

  if (error) return <div className="text-sm text-error">Failed to load session</div>;
  if (!data) return <div className="skeleton h-32 w-full" />;
  if (!data.trace) return <div className="text-sm text-ink-muted py-4">No session trace available</div>;

  return <SessionTrace trace={data.trace} sessions={data.sessions} />;
}
