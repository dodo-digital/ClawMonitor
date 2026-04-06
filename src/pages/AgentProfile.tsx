import { useState } from "react";
import { useParams, Link } from "react-router";
import {
  useAgents,
  useApi,
  apiPut,
  useSummary,
  useCosts,
  type Agent,
  type AnalyticsSummary,
  type CostsSummary,
  type AgentContextData,
  type AgentContextFile,
  type AgentContextFileContent,
  type RegistryData,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { formatNumber, formatCost, cn } from "@/lib/utils";
import {
  ArrowLeft,
  Bot,
  Globe,
  Folder,
  Cpu,
  MessageSquare,
  DollarSign,
  Activity,
  Clock,
  FileText,
  Check,
  X,
  Link as LinkIcon,
  ChevronDown,
  ChevronRight,
  Wrench,
} from "lucide-react";

export function AgentProfile() {
  const { agentId } = useParams<{ agentId: string }>();
  const { data: agents, error } = useAgents();

  if (error) return <ErrorState message="Failed to load agents" />;
  if (!agents) return <PageSkeleton />;

  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    return (
      <div className="text-center py-20">
        <p className="text-ink-muted mb-4">Agent "{agentId}" not found</p>
        <Link to="/agents" className="text-accent hover:underline text-sm">Back to agents</Link>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <Link to="/agents" className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-accent transition-colors mb-3">
          <ArrowLeft className="w-3.5 h-3.5" />
          All agents
        </Link>
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center">
            {agent.runtimeType === "acp" ? (
              <Globe className="w-6 h-6 text-accent" />
            ) : (
              <Bot className="w-6 h-6 text-accent" />
            )}
          </div>
          <div>
            <h1 className="text-xl font-bold text-ink">{agent.displayName ?? agent.id}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <Badge variant={agent.runtimeType === "native" ? "accent" : "default"}>
                {agent.runtimeType}
              </Badge>
              <span className="text-sm text-ink-faint font-mono">{agent.id}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left column: config + stats */}
        <div className="space-y-5">
          <ConfigCard agent={agent} />
          <StatsCard agentId={agent.id} />
        </div>

        {/* Middle column: identity files */}
        <div className="space-y-5">
          <IdentityCard agent={agent} />
          <CronCard agentId={agent.id} />
        </div>

        {/* Right column: knowledge */}
        <div>
          <KnowledgeCard agentId={agent.id} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config card
// ---------------------------------------------------------------------------

function ConfigCard({ agent }: { agent: Agent }) {
  const modelName = typeof agent.model === "string" ? agent.model : (agent.model?.primary ?? "unknown");
  const fallbacks = typeof agent.model === "object" ? agent.model.fallbacks : [];

  return (
    <div className="bg-card rounded-xl p-5">
      <h2 className="text-sm font-semibold text-ink mb-4">Configuration</h2>
      <div className="space-y-3">
        <Row icon={Folder} label="Workspace" value={agent.workspace ?? "default"} mono />
        <Row icon={Cpu} label="Model" value={modelName} mono />
        {fallbacks.length > 0 && (
          <div className="ml-6">
            <span className="text-[10px] text-ink-faint uppercase tracking-wider">Fallbacks</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {fallbacks.map((f) => <Badge key={f} variant="muted">{f}</Badge>)}
            </div>
          </div>
        )}
        <Row icon={MessageSquare} label="Sessions" value={formatNumber(agent.sessionCount)} />
        {agent.telegramBinding && (
          <Row icon={LinkIcon} label="Telegram" value="Bound" />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats card (uses ?agent= filtering)
// ---------------------------------------------------------------------------

function StatsCard({ agentId }: { agentId: string }) {
  const ap = `agent=${encodeURIComponent(agentId)}`;
  const { data: summary } = useSummary(ap);
  const { data: costs } = useCosts(ap);

  return (
    <div className="bg-card rounded-xl p-5">
      <h2 className="text-sm font-semibold text-ink mb-4">Last 24h</h2>
      {!summary ? (
        <div className="text-sm text-ink-faint">Loading...</div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Stat icon={Activity} label="Runs" value={formatNumber(summary.last24h.runs_24h)} />
          <Stat icon={MessageSquare} label="Messages" value={formatNumber(summary.last24h.messages_24h)} />
          <Stat icon={Wrench} label="Tool Calls" value={formatNumber(summary.last24h.tool_calls_24h)} />
          <Stat icon={DollarSign} label="Cost (24h)" value={costs ? formatCost(costs.summary.cost_24h) : "-"} />
          <Stat icon={DollarSign} label="Cost (7d)" value={costs ? formatCost(costs.summary.cost_7d) : "-"} />
          <Stat icon={DollarSign} label="Cost (all)" value={costs ? formatCost(costs.summary.total_cost) : "-"} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identity files card
// ---------------------------------------------------------------------------

function IdentityCard({ agent }: { agent: Agent }) {
  const files = agent.identityFiles ?? [];
  if (files.length === 0) {
    return (
      <div className="bg-card rounded-xl p-5">
        <h2 className="text-sm font-semibold text-ink mb-3">Identity Files</h2>
        <p className="text-sm text-ink-faint">No identity files tracked for this agent.</p>
      </div>
    );
  }

  const existing = files.filter((f) => f.exists);
  const missing = files.filter((f) => !f.exists);

  return (
    <div className="bg-card rounded-xl p-5">
      <h2 className="text-sm font-semibold text-ink mb-1">Identity Files</h2>
      <p className="text-[11px] text-ink-faint mb-3">
        {existing.length} of {files.length} present in workspace
      </p>
      <div className="space-y-1.5">
        {files.map((f) => (
          <div
            key={f.name}
            className={cn(
              "flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm",
              f.exists ? "bg-healthy/5 text-ink" : "bg-error/5 text-ink-faint",
            )}
          >
            {f.exists ? (
              <Check className="w-3.5 h-3.5 text-healthy shrink-0" />
            ) : (
              <X className="w-3.5 h-3.5 text-error shrink-0" />
            )}
            <span className="font-mono text-[12px]">{f.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cron card
// ---------------------------------------------------------------------------

function CronCard({ agentId }: { agentId: string }) {
  const { data } = useApi<RegistryData>("/api/cron/registry", { refreshInterval: 60_000 });
  if (!data) return null;

  const jobs = data.jobs.filter((j) => (j as { agentId?: string }).agentId === agentId);
  if (jobs.length === 0) return null;

  return (
    <div className="bg-card rounded-xl p-5">
      <h2 className="text-sm font-semibold text-ink mb-3">Cron Jobs</h2>
      <div className="space-y-2">
        {jobs.map((job) => {
          const status = job.health?.status ?? "unknown";
          const dotColor: Record<string, string> = {
            healthy: "bg-healthy",
            failing: "bg-error",
            disabled: "bg-cream-dark",
            unknown: "bg-warning",
          };
          return (
            <Link
              key={job.id}
              to="/cron"
              className="flex items-center gap-2.5 px-2.5 py-2 rounded-md hover:bg-sidebar-hover/30 transition-colors"
            >
              <div className={cn("w-2 h-2 rounded-full shrink-0", dotColor[status])} />
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-ink truncate">{job.name}</div>
                <div className="text-[10px] text-ink-faint font-mono">{job.schedule}</div>
              </div>
              <Badge variant={status === "healthy" ? "success" : status === "failing" ? "destructive" : "muted"}>
                {status}
              </Badge>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Knowledge card
// ---------------------------------------------------------------------------

function KnowledgeCard({ agentId }: { agentId: string }) {
  const { data } = useApi<AgentContextData>(
    `/api/memory/agent-context?agent=${encodeURIComponent(agentId)}`,
    { refreshInterval: 0 },
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<AgentContextFileContent | null>(null);
  const [editContent, setEditContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  async function viewFile(filePath: string) {
    if (expanded === filePath) {
      if (dirty && !confirm("You have unsaved changes. Discard?")) return;
      setExpanded(null);
      setFileContent(null);
      setEditContent(null);
      setDirty(false);
      return;
    }
    setExpanded(filePath);
    setLoading(true);
    setDirty(false);
    try {
      const res = await fetch(`/api/memory/agent-context/file?path=${encodeURIComponent(filePath)}`);
      const json = await res.json();
      const content = json.data?.content ?? "";
      setFileContent(json.data ?? null);
      setEditContent(content);
    } catch {
      setFileContent(null);
      setEditContent(null);
    } finally {
      setLoading(false);
    }
  }

  async function saveFile() {
    if (!expanded || editContent === null) return;
    setSaving(true);
    try {
      await apiPut(`/api/memory/agent-context/file?path=${encodeURIComponent(expanded)}`, { content: editContent });
      setDirty(false);
      // Update the cached content
      if (fileContent) {
        setFileContent({ ...fileContent, content: editContent, size: editContent.length });
      }
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setSaving(false);
    }
  }

  if (!data) {
    return (
      <div className="bg-card rounded-xl p-5">
        <h2 className="text-sm font-semibold text-ink mb-3">Knowledge</h2>
        <div className="text-sm text-ink-faint">Loading...</div>
      </div>
    );
  }

  const { registered, stats } = data;
  const categories = new Map<string, AgentContextFile[]>();
  for (const f of registered) {
    const list = categories.get(f.category) ?? [];
    list.push(f);
    categories.set(f.category, list);
  }

  return (
    <div className="bg-card rounded-xl p-5">
      <h2 className="text-sm font-semibold text-ink mb-1">Knowledge Graph</h2>
      <p className="text-[11px] text-ink-faint mb-3">
        {stats.totalExisting} files registered, {stats.totalMissing} missing, {stats.totalOrphans} orphaned
      </p>

      {registered.length === 0 ? (
        <p className="text-sm text-ink-faint">No extra paths configured for this agent.</p>
      ) : (
        <div className="space-y-3">
          {Array.from(categories.entries()).map(([cat, files]) => (
            <div key={cat}>
              <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-1">{cat}</div>
              <div className="space-y-0.5">
                {files.map((f) => (
                  <div key={f.path}>
                    <button
                      onClick={() => f.exists && !f.isDirectory && viewFile(f.path)}
                      className={cn(
                        "flex items-center gap-1.5 w-full text-left px-2 py-1 rounded text-[11px] transition-colors",
                        f.exists
                          ? "text-ink hover:bg-sidebar-hover/30 cursor-pointer"
                          : "text-ink-faint/50 line-through cursor-default",
                        expanded === f.path && "bg-accent/10",
                      )}
                    >
                      {f.exists && !f.isDirectory ? (
                        expanded === f.path ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />
                      ) : (
                        <FileText className="w-3 h-3 shrink-0 opacity-40" />
                      )}
                      <span className="font-mono truncate">{f.relativePath}</span>
                    </button>
                    {expanded === f.path && (
                      <div className="ml-5 mt-1 mb-2">
                        {loading ? (
                          <div className="p-3 bg-sidebar/50 rounded-md text-[11px] text-ink-faint">Loading...</div>
                        ) : (
                          <>
                            <textarea
                              value={editContent ?? ""}
                              onChange={(e) => { setEditContent(e.target.value); setDirty(true); }}
                              spellCheck={false}
                              className="w-full p-3 bg-sidebar/50 rounded-md text-[11px] font-mono text-ink-muted leading-relaxed resize-y min-h-[120px] max-h-[400px] focus:outline-none focus:ring-1 focus:ring-accent/30 border border-transparent focus:border-accent/20"
                            />
                            <div className="flex items-center justify-between mt-1.5">
                              <span className="text-[10px] text-ink-faint tabular-nums">
                                {editContent?.length ?? 0} chars
                              </span>
                              <button
                                onClick={saveFile}
                                disabled={!dirty || saving}
                                className={cn(
                                  "inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors",
                                  dirty
                                    ? "bg-accent text-white hover:bg-accent-muted"
                                    : "bg-cream-dark text-ink-faint cursor-not-allowed",
                                )}
                              >
                                {saving ? "Saving..." : "Save"}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function Row({ icon: Icon, label, value, mono }: { icon: typeof Bot; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-ink-faint mt-0.5"><Icon className="w-3.5 h-3.5" /></span>
      <div className="min-w-0">
        <span className="text-[10px] text-ink-faint uppercase tracking-wider">{label}</span>
        <p className={cn("text-sm text-ink truncate", mono && "font-mono")}>{value}</p>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Activity; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="w-3.5 h-3.5 text-ink-faint shrink-0" />
      <div>
        <div className="text-[10px] text-ink-faint">{label}</div>
        <div className="text-sm font-semibold text-ink tabular-nums">{value}</div>
      </div>
    </div>
  );
}
