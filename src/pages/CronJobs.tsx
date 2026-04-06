import { useState } from "react";
import { useParams } from "react-router";
import { PageHeader } from "@/components/layout/PageHeader";
import { useCronRegistry, useExecSecurity, usePendingApprovals, apiPut, apiPost, type RegistryJob, type ExecSecuritySettings } from "@/lib/api";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { formatDuration, formatLocal, humanCron, cn } from "@/lib/utils";
import { Search, ChevronDown, ChevronRight, AlertTriangle, Terminal, ShieldCheck, ShieldX, ShieldPlus } from "lucide-react";
import { JobDetail } from "@/components/cron/JobDetail";

type HealthStatus = "healthy" | "failing" | "disabled" | "unknown";
type FilterKey = HealthStatus | "all";

const statusDot: Record<HealthStatus, string> = {
  healthy: "bg-healthy",
  failing: "bg-error",
  disabled: "bg-cream-dark",
  unknown: "bg-warning",
};

const statusPill: Record<HealthStatus, { idle: string; active: string }> = {
  healthy: { idle: "text-healthy", active: "bg-healthy text-white" },
  failing: { idle: "text-error", active: "bg-error text-white" },
  disabled: { idle: "text-ink-faint", active: "bg-ink-faint text-white" },
  unknown: { idle: "text-warning", active: "bg-warning text-white" },
};

const layerBorder: Record<string, string> = {
  openclaw: "border-l-accent",
  linux: "border-l-channel-telegram",
};

const layerTag: Record<string, { text: string; label: string }> = {
  openclaw: { text: "text-accent", label: "OpenClaw" },
  linux: { text: "text-channel-telegram", label: "Linux" },
};

// ---------------------------------------------------------------------------
// Pending Approval Queue
// ---------------------------------------------------------------------------

function ApprovalQueue() {
  const { data, mutate } = usePendingApprovals();
  const [resolving, setResolving] = useState<string | null>(null);

  if (!data || data.approvals.length === 0) return null;

  async function resolve(id: string, decision: "allow-once" | "allow-always" | "deny") {
    setResolving(id);
    try {
      await apiPost(`/api/system/exec-approvals/${id}/resolve`, { decision });
      await mutate();
    } finally {
      setResolving(null);
    }
  }

  return (
    <div className="mb-3 rounded-lg bg-accent/5 border border-accent/20 overflow-hidden">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-accent/10">
        <Terminal className="w-3.5 h-3.5 text-accent" />
        <span className="text-[11px] font-semibold text-accent">
          {data.approvals.length} command{data.approvals.length !== 1 ? "s" : ""} waiting for approval
        </span>
      </div>

      <div className="divide-y divide-border/30">
        {data.approvals.map((approval) => {
          const fullCommand = [approval.command, ...approval.args].join(" ");
          const isResolving = resolving === approval.id;
          const age = Math.round((Date.now() - approval.receivedAt) / 1000);

          return (
            <div key={approval.id} className="px-3 py-2.5">
              <div className="flex items-start gap-2">
                {/* Command display */}
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[11px] text-ink bg-cream-dark/50 px-2 py-1 rounded break-all">
                    {fullCommand}
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-[10px] text-ink-faint">
                    {approval.agentId && <span>Agent: {approval.agentId}</span>}
                    {approval.cwd && <span className="truncate max-w-[200px]" title={approval.cwd}>in {approval.cwd}</span>}
                    <span>{age}s ago</span>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    disabled={isResolving}
                    onClick={() => resolve(approval.id, "allow-once")}
                    title="Allow this one time"
                    className={cn(
                      "flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors",
                      "bg-healthy/10 text-healthy hover:bg-healthy/20",
                      isResolving && "opacity-50",
                    )}
                  >
                    <ShieldCheck className="w-3 h-3" />
                    Once
                  </button>
                  <button
                    disabled={isResolving}
                    onClick={() => resolve(approval.id, "allow-always")}
                    title="Allow and remember — this command will always be permitted"
                    className={cn(
                      "flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors",
                      "bg-accent/10 text-accent hover:bg-accent/20",
                      isResolving && "opacity-50",
                    )}
                  >
                    <ShieldPlus className="w-3 h-3" />
                    Always
                  </button>
                  <button
                    disabled={isResolving}
                    onClick={() => resolve(approval.id, "deny")}
                    title="Block this command"
                    className={cn(
                      "flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors",
                      "bg-error/10 text-error hover:bg-error/20",
                      isResolving && "opacity-50",
                    )}
                  >
                    <ShieldX className="w-3 h-3" />
                    Deny
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exec Security Config Panel
// ---------------------------------------------------------------------------

type SettingOption = { value: string; label: string; description: string };

const SECURITY_OPTIONS: SettingOption[] = [
  { value: "full", label: "Full", description: "All commands run without restriction. Best for single-user setups and cron jobs." },
  { value: "allowlist", label: "Allowlist", description: "Only pre-approved commands run. Complex commands (pipes, chaining) are blocked unless every part is approved." },
  { value: "deny", label: "Deny", description: "No commands can run at all. Use for sandboxed or read-only agents." },
];

const ASK_OPTIONS: SettingOption[] = [
  { value: "off", label: "Off", description: "Commands run immediately, no prompts. Required for unattended cron jobs." },
  { value: "on-miss", label: "On miss", description: "Prompt in the Control UI the first time a new command is seen, then remember the approval permanently. If the Control UI isn't open, falls back to the Fallback Behavior below." },
  { value: "always", label: "Always", description: "Prompt in the Control UI for every command, every time. Cron jobs will use the Fallback Behavior since no one is watching. Note: approval prompts only appear in the Control UI, not Telegram or Slack." },
];

const FALLBACK_OPTIONS: SettingOption[] = [
  { value: "full", label: "Allow", description: "If approval is needed but nobody has the Control UI open, allow the command anyway. Cron jobs run unblocked." },
  { value: "allowlist", label: "Allowlist only", description: "If nobody is around to approve, only run commands that are already in the allowlist. New commands silently fail." },
  { value: "deny", label: "Deny", description: "If nobody is around to approve, block the command. The cron job logs the failure and moves on — it won't hang." },
];

const BOOL_OPTIONS: SettingOption[] = [
  { value: "false", label: "Off", description: "Inline code (python -c, node -e, etc.) runs freely." },
  { value: "true", label: "On", description: "Inline code requires explicit approval, even if the interpreter is allowed." },
];

type SettingRowProps = {
  label: string;
  sublabel: string;
  value: string | null;
  options: SettingOption[];
  saving: boolean;
  onChange: (value: string) => void;
};

function SettingRow({ label, sublabel, value, options, saving, onChange }: SettingRowProps) {
  const current = options.find((o) => o.value === (value ?? ""));
  const displayValue = value ?? "not set";

  return (
    <div className="grid grid-cols-[1fr_160px] gap-3 items-start py-2.5 border-b border-border/40 last:border-b-0">
      <div>
        <div className="text-xs font-medium text-ink">{label}</div>
        <div className="text-[10px] text-ink-faint mt-0.5">{sublabel}</div>
        {current && (
          <div className="text-[10px] text-ink-muted mt-1">{current.description}</div>
        )}
        {!value && (
          <div className="text-[10px] text-warning mt-1">Not configured — using OpenClaw default</div>
        )}
      </div>
      <div>
        <select
          value={displayValue}
          disabled={saving}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "w-full text-[11px] px-2 py-1.5 rounded-md border border-border bg-card text-ink",
            "focus:outline-none focus:border-accent",
            saving && "opacity-50",
          )}
        >
          {!value && <option value="not set" disabled>not set</option>}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

type Preset = {
  id: string;
  label: string;
  description: string;
  detail: string;
  values: Record<string, string | boolean>;
};

const PRESETS: Preset[] = [
  {
    id: "autonomous",
    label: "Autonomous",
    description: "Full power, no guardrails. Everything runs without asking.",
    detail: "The agent can run any command at any time. Cron jobs execute without interruption. Best for single-user servers where you trust the agent completely.",
    values: {
      gatewayExecSecurity: "full",
      gatewayExecAsk: "off",
      gatewayStrictInlineEval: false,
      approvalsDefaultSecurity: "full",
      approvalsDefaultAsk: "off",
      approvalsDefaultAskFallback: "full",
    },
  },
  {
    id: "supervised",
    label: "Supervised",
    description: "Approve new commands once via the Control UI, then they're remembered forever.",
    detail: "The first time the agent tries a new command, you'll see an approval prompt in the Control UI. Once approved, that command is permanently allowed. Cron jobs still run when you're away — unapproved commands are allowed by fallback so nothing hangs.",
    values: {
      gatewayExecSecurity: "full",
      gatewayExecAsk: "on-miss",
      gatewayStrictInlineEval: false,
      approvalsDefaultSecurity: "full",
      approvalsDefaultAsk: "on-miss",
      approvalsDefaultAskFallback: "full",
    },
  },
  {
    id: "guarded",
    label: "Guarded",
    description: "Only pre-approved commands run. Unknown commands are silently blocked.",
    detail: "Complex commands (pipes, chaining) are blocked unless every part is in the allowlist. Cron jobs will skip commands that aren't pre-approved — the job logs the failure and continues. Approval prompts appear in the Control UI when you're watching.",
    values: {
      gatewayExecSecurity: "allowlist",
      gatewayExecAsk: "on-miss",
      gatewayStrictInlineEval: true,
      approvalsDefaultSecurity: "allowlist",
      approvalsDefaultAsk: "on-miss",
      approvalsDefaultAskFallback: "deny",
    },
  },
  {
    id: "locked",
    label: "Locked Down",
    description: "No command execution at all. The agent can only read and respond.",
    detail: "Shell commands are completely disabled. The agent can still read files, search memory, and use tools that don't involve exec. Cron jobs that need to run scripts will fail.",
    values: {
      gatewayExecSecurity: "deny",
      gatewayExecAsk: "always",
      gatewayStrictInlineEval: true,
      approvalsDefaultSecurity: "deny",
      approvalsDefaultAsk: "always",
      approvalsDefaultAskFallback: "deny",
    },
  },
];

function detectActivePreset(settings: ExecSecuritySettings): string | null {
  for (const preset of PRESETS) {
    const match = Object.entries(preset.values).every(([key, expected]) => {
      const actual = settings[key as keyof ExecSecuritySettings];
      if (typeof expected === "boolean") return actual === expected;
      return actual === expected;
    });
    if (match) return preset.id;
  }
  return null;
}

function ExecSecurityPanel() {
  const { data, mutate } = useExecSecurity();
  const [expanded, setExpanded] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!data) return null;

  const { settings, cronReady, cronBlockers } = data;
  const activePreset = detectActivePreset(settings);

  async function updateSetting(update: Record<string, string | boolean>) {
    setSaving(true);
    try {
      await apiPut("/api/system/exec-security", update);
      await mutate();
    } finally {
      setSaving(false);
    }
  }

  async function applyPreset(preset: Preset) {
    setSaving(true);
    try {
      await apiPut("/api/system/exec-security", preset.values);
      await mutate();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-3 rounded-lg bg-card border border-border overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-cream/40 transition-colors"
      >
        {expanded
          ? <ChevronDown className="w-3 h-3 text-ink-faint" />
          : <ChevronRight className="w-3 h-3 text-ink-faint" />
        }
        <span className="text-[11px] font-medium text-ink">Execution Permissions</span>

        {activePreset && (
          <span className="text-[10px] text-ink-muted">
            — {PRESETS.find((p) => p.id === activePreset)?.label}
          </span>
        )}
        {!activePreset && (
          <span className="text-[10px] text-ink-faint">— Custom</span>
        )}

        {cronReady ? (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-healthy">
            <span className="w-1.5 h-1.5 rounded-full bg-healthy" />
            Cron-ready
          </span>
        ) : (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-warning">
            <AlertTriangle className="w-3 h-3" />
            {cronBlockers.length} issue{cronBlockers.length !== 1 ? "s" : ""}
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3">
          {/* Cron blockers */}
          {cronBlockers.length > 0 && (
            <div className="mb-3 px-2.5 py-2 rounded-md bg-warning/10 border border-warning/20">
              <div className="text-[10px] font-medium text-warning mb-1">Cron jobs may not run with current settings:</div>
              {cronBlockers.map((msg, i) => (
                <div key={i} className="text-[10px] text-warning/80 leading-relaxed">• {msg}</div>
              ))}
            </div>
          )}

          {/* Presets */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            {PRESETS.map((preset) => {
              const isActive = activePreset === preset.id;
              return (
                <button
                  key={preset.id}
                  disabled={saving}
                  onClick={() => !isActive && applyPreset(preset)}
                  className={cn(
                    "text-left px-3 py-2.5 rounded-lg border transition-all",
                    isActive
                      ? "border-accent bg-accent/5 ring-1 ring-accent/30"
                      : "border-border hover:border-ink-faint/40 hover:bg-cream/40",
                    saving && "opacity-50 cursor-not-allowed",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={cn(
                      "text-[11px] font-semibold",
                      isActive ? "text-accent" : "text-ink",
                    )}>
                      {preset.label}
                    </span>
                    {isActive && (
                      <span className="text-[9px] font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded-full">
                        Active
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-ink-muted mt-0.5 leading-relaxed">
                    {preset.description}
                  </div>
                  <div className="text-[9px] text-ink-faint mt-1 leading-relaxed">
                    {preset.detail}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Advanced toggle */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-[10px] text-ink-faint hover:text-ink-muted transition-colors mb-1"
          >
            {showAdvanced
              ? <ChevronDown className="w-2.5 h-2.5" />
              : <ChevronRight className="w-2.5 h-2.5" />
            }
            Advanced — edit individual settings
          </button>

          {showAdvanced && (
            <>
              {/* Gateway settings (openclaw.json) */}
              <div className="text-[10px] font-bold text-ink-faint uppercase tracking-wider mt-2 mb-1">
                Gateway Policy
                <span className="font-normal normal-case tracking-normal ml-1 text-ink-faint/60">openclaw.json</span>
              </div>

              <SettingRow
                label="Security Mode"
                sublabel="Controls what types of commands the agent can run"
                value={settings.gatewayExecSecurity}
                options={SECURITY_OPTIONS}
                saving={saving}
                onChange={(v) => updateSetting({ gatewayExecSecurity: v })}
              />
              <SettingRow
                label="Approval Prompts"
                sublabel="Whether to ask before running commands"
                value={settings.gatewayExecAsk}
                options={ASK_OPTIONS}
                saving={saving}
                onChange={(v) => updateSetting({ gatewayExecAsk: v })}
              />
              <SettingRow
                label="Strict Inline Eval"
                sublabel='Whether "python -c" or "node -e" style commands need extra approval'
                value={settings.gatewayStrictInlineEval === null ? null : String(settings.gatewayStrictInlineEval)}
                options={BOOL_OPTIONS}
                saving={saving}
                onChange={(v) => updateSetting({ gatewayStrictInlineEval: v === "true" })}
              />

              {/* Approval daemon settings (exec-approvals.json) */}
              <div className="text-[10px] font-bold text-ink-faint uppercase tracking-wider mt-4 mb-1">
                Approval Daemon
                <span className="font-normal normal-case tracking-normal ml-1 text-ink-faint/60">exec-approvals.json</span>
              </div>

              <SettingRow
                label="Security Mode"
                sublabel="Second layer of enforcement — must agree with gateway policy above"
                value={settings.approvalsDefaultSecurity}
                options={SECURITY_OPTIONS}
                saving={saving}
                onChange={(v) => updateSetting({ approvalsDefaultSecurity: v })}
              />
              <SettingRow
                label="Approval Prompts"
                sublabel="When the approval daemon asks for confirmation"
                value={settings.approvalsDefaultAsk}
                options={ASK_OPTIONS}
                saving={saving}
                onChange={(v) => updateSetting({ approvalsDefaultAsk: v })}
              />
              <SettingRow
                label="Fallback Behavior"
                sublabel="What happens when a prompt is required but nobody is around to answer"
                value={settings.approvalsDefaultAskFallback}
                options={FALLBACK_OPTIONS}
                saving={saving}
                onChange={(v) => updateSetting({ approvalsDefaultAskFallback: v })}
              />

              {/* Wildcard status */}
              <div className="flex items-center gap-2 mt-3 pt-2 border-t border-border/40">
                <span className={cn(
                  "w-1.5 h-1.5 rounded-full",
                  settings.approvalsHasWildcard ? "bg-healthy" : "bg-warning",
                )} />
                <span className="text-[10px] text-ink-muted">
                  Global allowlist wildcard (*): {settings.approvalsHasWildcard ? "present" : "missing — only specifically approved commands will match"}
                </span>
              </div>
            </>
          )}

          <div className="text-[9px] text-ink-faint/60 mt-2">
            Changes take effect immediately. Gateway restart may be needed for some settings to fully propagate.
          </div>
        </div>
      )}
    </div>
  );
}

export function CronJobs() {
  const { agentId } = useParams<{ agentId?: string }>();
  const { data, error, mutate } = useCronRegistry();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [layerFilter, setLayerFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  if (error) return <ErrorState message="Failed to load cron registry" onRetry={() => mutate()} />;
  if (!data) return <PageSkeleton />;

  // When viewed under an agent, filter to that agent's jobs
  const jobs = agentId
    ? data.jobs.filter((j) => j.agentId === agentId)
    : data.jobs;

  const counts = { healthy: 0, failing: 0, disabled: 0, unknown: 0 };
  for (const job of jobs) counts[job.health?.status ?? "unknown"]++;

  // Sort: failing first, then by run activity (most runs), then by last run time
  const statusOrder: Record<string, number> = { failing: 0, healthy: 1, unknown: 2, disabled: 3 };
  const sorted = [...jobs].sort((a, b) => {
    const sa = statusOrder[a.health?.status ?? "unknown"] ?? 2;
    const sb = statusOrder[b.health?.status ?? "unknown"] ?? 2;
    if (sa !== sb) return sa - sb;
    // Jobs with runs before jobs without
    const ra = a.stats?.total ?? 0;
    const rb = b.stats?.total ?? 0;
    if ((ra > 0) !== (rb > 0)) return rb - ra;
    // Most recent run first
    const la = a.stats?.lastRunAt ?? 0;
    const lb = b.stats?.lastRunAt ?? 0;
    return lb - la;
  });

  const filtered = sorted.filter((job) => {
    const s = job.health?.status ?? "unknown";
    if (filter !== "all" && s !== filter) return false;
    if (layerFilter !== "all" && job.layer !== layerFilter) return false;
    if (search && !job.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  async function toggleJob(job: RegistryJob) {
    await apiPut(`/api/cron/registry/${job.id}`, { enabled: !job.enabled });
    mutate();
  }

  const hasFilters = filter !== "all" || layerFilter !== "all" || search;

  return (
    <div>
      <PageHeader section="04" title="Cron Jobs" description={`${jobs.length} jobs`} />

      <ApprovalQueue />
      <ExecSecurityPanel />

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-1">
          {(["healthy", "failing", "disabled", "unknown"] as HealthStatus[]).map((s) => {
            const active = filter === s;
            const pill = statusPill[s];
            if (counts[s] === 0 && !active) return null;
            return (
              <button
                key={s}
                onClick={() => setFilter(active ? "all" : s)}
                className={cn(
                  "inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors",
                  active ? pill.active : `bg-transparent ${pill.idle} hover:bg-cream-dark`,
                )}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full", active ? "bg-white/80" : statusDot[s])} />
                {counts[s]}
              </button>
            );
          })}
        </div>

        <span className="w-px h-4 bg-border" />

        <div className="flex items-center gap-1">
          {(["all", "openclaw", "linux"] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLayerFilter(l)}
              className={cn(
                "px-2 py-1 rounded-md text-[11px] font-medium transition-colors",
                layerFilter === l ? "bg-ink text-cream" : "text-ink-muted hover:bg-cream-dark",
              )}
            >
              {l === "all" ? "All" : l === "openclaw" ? "OpenClaw" : "Linux"}
            </button>
          ))}
        </div>

        <div className="relative ml-auto w-48">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-faint" />
          <input
            type="text"
            placeholder="Filter..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-7 pr-2 py-1 text-[11px] bg-transparent border-b border-border focus:border-accent focus:outline-none text-ink placeholder:text-ink-faint"
          />
        </div>

        {hasFilters && (
          <button
            onClick={() => { setFilter("all"); setLayerFilter("all"); setSearch(""); }}
            className="text-[11px] text-accent hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      {/* Job list */}
      <div className="bg-card rounded-xl overflow-hidden">
        <div className="grid grid-cols-[16px_1fr_120px_100px_60px_32px] gap-x-3 px-4 py-1.5 border-b border-border">
          <span />
          <span className="text-[10px] font-medium text-ink-faint uppercase tracking-wider">Job</span>
          <span className="text-[10px] font-medium text-ink-faint uppercase tracking-wider">Schedule</span>
          <span className="text-[10px] font-medium text-ink-faint uppercase tracking-wider">Last Run</span>
          <span className="text-[10px] font-medium text-ink-faint uppercase tracking-wider">Runs</span>
          <span />
        </div>

        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-ink-muted">No matching jobs</div>
        )}

        {filtered.map((job) => {
          const health = job.health?.status ?? "unknown";
          const border = layerBorder[job.layer] ?? "border-l-ink-faint";
          const tag = layerTag[job.layer] ?? { text: "text-ink-muted", label: "?" };
          const { stats } = job;

          return (
            <div
              key={job.id}
              onClick={() => setSelectedJobId(job.id)}
              className={cn(
                "grid grid-cols-[16px_1fr_120px_100px_60px_32px] gap-x-3 items-center",
                "pl-4 pr-4 py-[7px] border-l-[3px] cursor-pointer transition-colors",
                "border-b border-border/40 last:border-b-0",
                "hover:bg-cream/60",
                border,
                !job.enabled && "opacity-50",
              )}
            >
              {/* Status dot */}
              <span className={cn("w-[6px] h-[6px] rounded-full justify-self-center", statusDot[health])} />

              {/* Name + layer */}
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs text-ink font-medium truncate">{job.name}</span>
                <span className={cn("text-[9px] font-bold uppercase tracking-wide flex-shrink-0 opacity-60", tag.text)}>
                  {tag.label}
                </span>
              </div>

              {/* Schedule */}
              <span className="text-[11px] text-ink-muted truncate" title={job.schedule}>
                {humanCron(job.schedule)}
              </span>

              {/* Last run — time + status indicator */}
              <div className="flex items-center gap-1.5 min-w-0">
                {stats.lastRunAt ? (
                  <>
                    <span className={cn(
                      "w-[5px] h-[5px] rounded-full flex-shrink-0",
                      stats.lastStatus === "ok" ? "bg-healthy" : "bg-error",
                    )} />
                    <span className="text-[11px] text-ink-faint truncate" title={formatLocal(stats.lastRunAt)}>
                      {formatLocal(stats.lastRunAt)}
                    </span>
                  </>
                ) : (
                  <span className="text-[11px] text-ink-faint">-</span>
                )}
              </div>

              {/* Success rate mini bar */}
              <div className="flex items-center gap-1.5">
                {stats.total > 0 ? (
                  <>
                    <SuccessBar rate={stats.successRate} />
                    <span className={cn(
                      "text-[10px] font-medium tabular-nums",
                      stats.successRate === 100 ? "text-healthy" : stats.successRate >= 70 ? "text-ink-muted" : "text-error",
                    )}>
                      {stats.successRate}%
                    </span>
                  </>
                ) : (
                  <span className="text-[10px] text-ink-faint">-</span>
                )}
              </div>

              {/* Toggle */}
              <div className="justify-self-center" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => toggleJob(job)}
                  className={cn(
                    "w-6 h-3.5 rounded-full transition-colors relative",
                    job.enabled ? "bg-healthy" : "bg-cream-dark",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-[3px] w-2 h-2 bg-white rounded-full transition-transform shadow-sm",
                      job.enabled ? "left-3" : "left-[3px]",
                    )}
                  />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {selectedJobId && (
        <JobDetail
          jobId={selectedJobId}
          onClose={() => setSelectedJobId(null)}
          onToggle={async () => {
            const job = jobs.find((j) => j.id === selectedJobId);
            if (job) {
              await apiPut(`/api/cron/registry/${job.id}`, { enabled: !job.enabled });
              mutate();
            }
          }}
        />
      )}
    </div>
  );
}

function SuccessBar({ rate }: { rate: number }) {
  return (
    <div className="w-5 h-1.5 rounded-full bg-cream-dark overflow-hidden flex-shrink-0">
      <div
        className={cn(
          "h-full rounded-full transition-all",
          rate === 100 ? "bg-healthy" : rate >= 70 ? "bg-warning" : "bg-error",
        )}
        style={{ width: `${rate}%` }}
      />
    </div>
  );
}
