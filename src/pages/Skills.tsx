import { useState } from "react";
import { Link } from "react-router";
import { Search, ChevronDown, ChevronRight, Zap, FileText, Eye, EyeOff } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/error-state";
import { PageSkeleton } from "@/components/ui/skeleton";
import {
  useSkills,
  useSkillTriggers,
  useSkillContent,
  useSummary,
  type SkillInfo,
} from "@/lib/api";
import { cn, formatRelativeTime, formatLocal, formatNumber } from "@/lib/utils";

const sourceStyle: Record<string, { text: string; label: string }> = {
  "openclaw-managed": { text: "text-accent", label: "Managed" },
  "openclaw-workspace": { text: "text-channel-telegram", label: "Workspace" },
  "openclaw-extra": { text: "text-warning", label: "Extra" },
  "openclaw-bundled": { text: "text-ink-muted", label: "Bundled" },
};

export function Skills() {
  const { data, error, mutate } = useSkills();
  const { data: summary } = useSummary();
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  if (error) {
    return <ErrorState message="Failed to load skills" onRetry={() => mutate()} />;
  }

  if (!data) {
    return <PageSkeleton />;
  }

  const skills = data.skills;
  const activeSkills = skills.filter((s) => s.triggerCount > 0);
  const topSkill = activeSkills.length > 0 ? activeSkills[0] : null;
  const sources = [...new Set(skills.map((s) => s.source))].sort();

  // Apply filters
  let filtered = skills;
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }
  if (sourceFilter !== "all") {
    filtered = filtered.filter((s) => s.source === sourceFilter);
  }

  const hasFilters = sourceFilter !== "all" || search;

  return (
    <div>
      <PageHeader
        title="Skills"
        description={`${skills.length} skills across ${sources.length} sources`}
      />

      {/* Toolbar — matches CronJobs pattern */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-1">
          <StatPill
            label={formatNumber(skills.length)}
            sublabel="total"
            active={false}
          />
          <StatPill
            label={formatNumber(activeSkills.length)}
            sublabel="active"
            tone="text-healthy"
            active={false}
          />
          <StatPill
            label={formatNumber(summary?.last24h.skill_triggers_24h ?? 0)}
            sublabel="triggers 24h"
            tone="text-accent"
            active={false}
          />
          {topSkill && (
            <StatPill
              label={topSkill.name}
              sublabel="top"
              tone="text-accent"
              active={false}
            />
          )}
        </div>

        <span className="w-px h-4 bg-border" />

        <div className="flex items-center gap-1">
          {(["all", ...sources] as const).map((s) => {
            const style = s === "all" ? null : sourceStyle[s];
            return (
              <button
                key={s}
                onClick={() => setSourceFilter(s)}
                className={cn(
                  "px-2 py-1 rounded-md text-[11px] font-medium transition-colors",
                  sourceFilter === s
                    ? "bg-ink text-cream"
                    : "text-ink-muted hover:bg-cream-dark",
                )}
              >
                {s === "all" ? "All" : style?.label ?? s}
              </button>
            );
          })}
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
            onClick={() => { setSourceFilter("all"); setSearch(""); }}
            className="text-[11px] text-accent hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      {/* Skills list */}
      <div className="bg-card rounded-xl overflow-hidden">
        <div className="grid grid-cols-[16px_1fr_100px_60px_100px] gap-x-3 px-4 py-1.5 border-b border-border">
          <span />
          <span className="text-[10px] font-medium text-ink-faint uppercase tracking-wider">Skill</span>
          <span className="text-[10px] font-medium text-ink-faint uppercase tracking-wider">Source</span>
          <span className="text-[10px] font-medium text-ink-faint uppercase tracking-wider text-right">Triggers</span>
          <span className="text-[10px] font-medium text-ink-faint uppercase tracking-wider">Last Used</span>
        </div>

        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-ink-muted">
            {search ? "No skills match your search" : "No skills found"}
          </div>
        )}

        {filtered.map((skill) => (
          <SkillRow
            key={skill.name}
            skill={skill}
            expanded={expanded === skill.name}
            onToggle={() => setExpanded(expanded === skill.name ? null : skill.name)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatPill({
  label,
  sublabel,
  tone,
  active: _active,
}: {
  label: string;
  sublabel: string;
  tone?: string;
  active: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1">
      <span className={cn("text-xs font-semibold tabular-nums", tone ?? "text-ink")}>{label}</span>
      <span className="text-[10px] text-ink-faint">{sublabel}</span>
    </div>
  );
}

function SkillRow({
  skill,
  expanded,
  onToggle,
}: {
  skill: SkillInfo;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isActive = skill.triggerCount > 0;
  const style = sourceStyle[skill.source] ?? { text: "text-ink-muted", label: "?" };

  return (
    <>
      <div
        onClick={onToggle}
        className={cn(
          "grid grid-cols-[16px_1fr_100px_60px_100px] gap-x-3 items-center",
          "px-4 py-[7px] border-l-[3px] cursor-pointer transition-colors",
          "border-b border-border/40 last:border-b-0",
          "hover:bg-cream/60",
          isActive ? "border-l-healthy" : "border-l-transparent",
        )}
      >
        {/* Status dot */}
        <span className={cn(
          "w-[6px] h-[6px] rounded-full justify-self-center",
          isActive ? "bg-healthy" : "bg-cream-dark",
        )} />

        {/* Name + description */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs text-ink font-medium truncate shrink-0 max-w-[160px]">{skill.name}</span>
          {skill.version && (
            <span className="text-[9px] text-ink-faint font-mono shrink-0">v{skill.version}</span>
          )}
          <span className="text-[11px] text-ink-faint truncate">{skill.description}</span>
        </div>

        {/* Source tag */}
        <span className={cn("text-[9px] font-bold uppercase tracking-wide opacity-60", style.text)}>
          {style.label}
        </span>

        {/* Trigger count */}
        <div className="flex items-center gap-1.5 justify-end">
          {isActive ? (
            <>
              <TriggerBar count={skill.triggerCount} max={Math.max(...([] as number[]), skill.triggerCount, 100)} />
              <span className="text-[10px] font-medium tabular-nums text-ink-muted">
                {skill.triggerCount}
              </span>
            </>
          ) : (
            <span className="text-[10px] text-ink-faint">-</span>
          )}
        </div>

        {/* Last used */}
        <span className="text-[11px] text-ink-faint truncate" title={skill.lastTriggered ? formatLocal(skill.lastTriggered) : ""}>
          {skill.lastTriggered ? formatRelativeTime(skill.lastTriggered) : "-"}
        </span>
      </div>

      {expanded && <SkillDetail skill={skill} />}
    </>
  );
}

function TriggerBar({ count, max }: { count: number; max: number }) {
  const pct = Math.min(100, (count / max) * 100);
  return (
    <div className="w-5 h-1.5 rounded-full bg-cream-dark overflow-hidden flex-shrink-0">
      <div
        className="h-full rounded-full bg-accent-muted transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function SkillDetail({ skill }: { skill: SkillInfo }) {
  const { data: triggersData, error: triggersError } = useSkillTriggers(skill.name);
  const { data: contentData } = useSkillContent(skill.name);
  const [showContent, setShowContent] = useState(false);

  return (
    <div className="bg-cream-dark/30 border-b border-border/40 px-5 py-4">
      {/* Header row with metadata + actions */}
      <div className="flex items-start gap-6 mb-4">
        {/* Left: metadata */}
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-accent shrink-0" />
            <span className="text-sm font-semibold text-ink">{skill.name}</span>
            {skill.version && <Badge variant="muted">v{skill.version}</Badge>}
            <Badge variant={skill.triggerCount > 0 ? "healthy" : "muted"}>
              {skill.triggerCount > 0 ? `${skill.triggerCount} triggers` : "unused"}
            </Badge>
          </div>

          <p className="text-xs text-ink-muted leading-relaxed">{skill.description}</p>

          <div className="flex items-center gap-4 text-[11px]">
            <span className="flex items-center gap-1.5 text-ink-faint">
              <FileText className="w-3 h-3" />
              <span className="font-mono text-[10px] truncate max-w-[400px]" title={skill.filePath}>
                {skill.filePath.replace(/^\/home\/chungbot\//, "~/")}
              </span>
            </span>
          </div>

          {skill.channels.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-ink-faint">Channels:</span>
              {skill.channels.map((ch) => (
                <Badge key={ch} variant="accent">{ch}</Badge>
              ))}
            </div>
          )}
        </div>

        {/* Right: view content toggle */}
        {contentData && (
          <button
            onClick={() => setShowContent(!showContent)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors shrink-0",
              showContent
                ? "bg-accent/10 text-accent"
                : "bg-cream-dark text-ink-muted hover:text-ink hover:bg-cream-dark/80",
            )}
          >
            {showContent ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            {showContent ? "Hide content" : "View SKILL.md"}
          </button>
        )}
      </div>

      {/* Skill content */}
      {showContent && contentData && (
        <div className="mb-4 rounded-lg border border-border/50 overflow-hidden">
          <div className="px-3 py-1.5 bg-cream-dark/50 border-b border-border/30 flex items-center gap-1.5">
            <FileText className="w-3 h-3 text-ink-faint" />
            <span className="text-[10px] font-medium text-ink-faint">SKILL.md</span>
          </div>
          <pre className="p-4 text-xs text-ink-muted font-mono whitespace-pre-wrap overflow-auto max-h-80 leading-relaxed">
            {contentData.content}
          </pre>
        </div>
      )}

      {/* Recent triggers */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-bold text-ink-faint uppercase tracking-wider">
            Recent Triggers
          </span>
          {triggersData && (
            <span className="text-[10px] text-ink-faint">
              {triggersData.total} total
            </span>
          )}
        </div>

        {triggersError && (
          <div className="text-xs text-error">Failed to load trigger history</div>
        )}

        {!triggersData && !triggersError && (
          <div className="flex items-center gap-2 py-3">
            <div className="w-3 h-3 rounded-full border-2 border-ink-faint/30 border-t-accent animate-spin" />
            <span className="text-[11px] text-ink-faint">Loading triggers...</span>
          </div>
        )}

        {triggersData && triggersData.triggers.length === 0 && (
          <div className="py-3 text-xs text-ink-faint">
            No triggers in the last {triggersData.days} days
          </div>
        )}

        {triggersData && triggersData.triggers.length > 0 && (
          <div className="rounded-lg border border-border/40 overflow-hidden">
            <div className="grid grid-cols-[140px_80px_1fr_80px] gap-x-3 px-3 py-1.5 border-b border-border/30">
              <span className="text-[10px] font-medium text-ink-faint uppercase tracking-wider">When</span>
              <span className="text-[10px] font-medium text-ink-faint uppercase tracking-wider">Agent</span>
              <span className="text-[10px] font-medium text-ink-faint uppercase tracking-wider">Session</span>
              <span className="text-[10px] font-medium text-ink-faint uppercase tracking-wider">Channel</span>
            </div>
            {triggersData.triggers.slice(0, 15).map((trigger) => (
              <div
                key={trigger.id}
                className="grid grid-cols-[140px_80px_1fr_80px] gap-x-3 px-3 py-1.5 border-b border-border/20 last:border-b-0 hover:bg-cream/30 transition-colors"
              >
                <span className="text-[11px] text-ink-faint truncate" title={formatLocal(trigger.timestamp)}>
                  {formatRelativeTime(trigger.timestamp)}
                </span>
                <span className="text-[11px] text-ink-muted font-medium truncate">{trigger.agent_id}</span>
                <Link
                  to={`/sessions`}
                  className="text-[11px] text-accent hover:underline truncate font-mono"
                  title={trigger.session_key}
                >
                  {trigger.session_key}
                </Link>
                <span className="text-[11px] text-ink-faint truncate">{trigger.channel}</span>
              </div>
            ))}
            {triggersData.triggers.length > 15 && (
              <div className="px-3 py-1.5 text-[10px] text-ink-faint border-t border-border/20">
                Showing 15 of {triggersData.total}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
