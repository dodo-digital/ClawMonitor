import { useState, useMemo } from "react";
import { useParams } from "react-router";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  useQmdStatus,
  useMemoryFiles,
  useLifeTree,
  useEntityDetail,
  useActivityFeed,
  useDataSources,
  useAgentContext,
  apiPost,
  type MemoryFile,
  type LifeTreeNode,
  type FactWithDecay,
  type ActivityFact,
  type AgentContextFile,
  type AgentContextFileContent,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { formatNumber, formatRelativeTime, formatBytes, cn } from "@/lib/utils";
import {
  Search,
  FileText,
  X,
  FolderTree,
  Activity,
  ChevronRight,
  ChevronDown,
  Circle,
  Layers,
  ArrowLeft,
  FolderOpen,
  Eye,
  EyeOff,
  AlertTriangle,
  Folder,
} from "lucide-react";

type Tab = "activity" | "knowledge" | "agent-context" | "notes" | "search";

type SearchResult = {
  path: string;
  score: number;
  snippet: string;
};

export function Memory() {
  const { agentId } = useParams<{ agentId?: string }>();
  const [tab, setTab] = useState<Tab>("agent-context");

  const tabs: { id: Tab; label: string; icon: React.ReactNode; desc: string }[] = [
    { id: "agent-context", label: "Agent Context", icon: <Layers className="w-3.5 h-3.5" />, desc: "Files the agent reads every sweep and can search" },
    { id: "activity", label: "What's New", icon: <Activity className="w-3.5 h-3.5" />, desc: "Facts the agent has saved about people, companies, and projects" },
    { id: "knowledge", label: "Entities", icon: <FolderTree className="w-3.5 h-3.5" />, desc: "Browse people, companies, and projects the agent knows about" },
    { id: "notes", label: "Daily Notes", icon: <FileText className="w-3.5 h-3.5" />, desc: "Session logs the agent writes each day" },
    { id: "search", label: "Search", icon: <Search className="w-3.5 h-3.5" />, desc: "Semantic search across all indexed knowledge" },
  ];

  const activeTab = tabs.find((t) => t.id === tab);

  return (
    <div>
      <PageHeader
        section="06"
        title="Knowledge Graph"
        description="See what the agent knows, what it can find, and where it saves data"
      />

      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-4 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px",
              tab === t.id
                ? "border-accent text-accent"
                : "border-transparent text-ink-muted hover:text-ink hover:border-border",
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab description */}
      {activeTab && (
        <p className="text-xs text-ink-muted mb-6">{activeTab.desc}</p>
      )}

      {tab === "activity" && <ActivityTab />}
      {tab === "knowledge" && <KnowledgeGraphTab />}
      {tab === "agent-context" && <AgentContextTab agentId={agentId} />}
      {tab === "notes" && <NotesTab />}
      {tab === "search" && <SearchTab />}
    </div>
  );
}

// =============================================================================
// What's New (Activity Feed) — default tab
// =============================================================================

function ActivityTab() {
  const { data, error, mutate } = useActivityFeed(200);

  const grouped = useMemo(() => {
    if (!data) return new Map<string, ActivityFact[]>();
    const map = new Map<string, ActivityFact[]>();
    for (const fact of data.facts) {
      const date = fact.timestamp ?? "unknown";
      if (!map.has(date)) map.set(date, []);
      map.get(date)!.push(fact);
    }
    return map;
  }, [data]);

  if (error) return <ErrorState message="Failed to load activity feed" onRetry={() => mutate()} />;
  if (!data) return <PageSkeleton />;

  return (
    <div className="max-w-3xl">
      <p className="text-sm text-ink-muted mb-6">
        Every time the agent learns something, it saves a fact to a file on disk.
        This feed shows those saves in reverse chronological order.
        <span className="text-ink-faint"> ({formatNumber(data.totalFacts)} facts across all entities)</span>
      </p>

      {/* Timeline */}
      <div className="space-y-8">
        {[...grouped.entries()].map(([date, facts]) => (
          <div key={date}>
            {/* Date header */}
            <div className="flex items-center gap-3 mb-3 sticky top-0 bg-cream py-2 z-10">
              <div className="w-2 h-2 rounded-full bg-accent" />
              <span className="text-sm font-semibold text-ink">{date}</span>
              <span className="text-xs text-ink-faint">{facts.length} {facts.length === 1 ? "fact" : "facts"} saved</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* Facts for this date */}
            <div className="space-y-2 ml-1">
              {facts.map((fact) => (
                <div
                  key={`${fact.entityPath}-${fact.factId}`}
                  className={cn(
                    "bg-card rounded-lg border border-border px-4 py-3",
                    fact.status === "superseded" && "opacity-50",
                  )}
                >
                  {/* What was saved */}
                  <p className={cn(
                    "text-sm text-ink leading-relaxed",
                    fact.status === "superseded" && "line-through",
                  )}>
                    {fact.fact}
                  </p>

                  {/* Where it was saved — the key missing piece */}
                  <div className="mt-2.5 flex items-start gap-2 text-xs">
                    <FolderOpen className="w-3.5 h-3.5 text-ink-faint mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <span className="font-mono text-accent">
                        life/{fact.entityPath}/items.json
                      </span>
                      <span className="text-ink-faint ml-2">
                        entity: <span className="text-ink-muted capitalize">{fact.entity}</span>
                      </span>
                    </div>
                  </div>

                  {/* Metadata row */}
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <Badge variant="muted">{fact.category}</Badge>
                    <Badge variant={fact.priority === "high" ? "accent" : "muted"}>{fact.priority}</Badge>
                    {fact.status === "superseded" && <Badge variant="warning">superseded</Badge>}
                    <span className="text-[11px] text-ink-faint ml-auto">
                      triggered by: {fact.source}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {data.facts.length === 0 && (
        <p className="text-sm text-ink-muted py-8 text-center">No activity found</p>
      )}
    </div>
  );
}

// =============================================================================
// Knowledge Graph Tab
// =============================================================================

function KnowledgeGraphTab() {
  const { data: tree, error, mutate } = useLifeTree();
  const { data: sources } = useDataSources();
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);

  if (error) return <ErrorState message="Failed to load knowledge graph" onRetry={() => mutate()} />;
  if (!tree) return <PageSkeleton />;

  if (selectedEntity) {
    return <EntityDetailView path={selectedEntity} onBack={() => setSelectedEntity(null)} />;
  }

  return (
    <div>
      {/* Data sources summary */}
      {sources && sources.length > 0 && (
        <div className="mb-6 bg-card rounded-xl p-5 border border-border">
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
            Registered Data Sources
          </h3>
          <div className="space-y-2">
            {sources.map((s) => (
              <div key={s.id} className="flex items-center gap-3 text-sm">
                {s.renderer === "entity-facts" ? (
                  <FolderTree className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                ) : (
                  <FileText className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                )}
                <span className="font-medium text-ink">{s.name}</span>
                <span className="text-ink-faint tabular-nums">{s.entityCount}</span>
                {s.description && (
                  <span className="text-xs text-ink-muted hidden sm:inline">— {s.description}</span>
                )}
                {s.native && <Badge variant="muted">native</Badge>}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-ink-faint mt-3">
            Configured in <span className="font-mono">data-sources.json</span>. Add your own sources to extend this view.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Tree sidebar */}
        <div className="lg:col-span-1">
          <div className="bg-card rounded-xl p-4 sticky top-20">
            <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
              Browse
            </h3>
            <div className="space-y-0.5">
              {tree
                .filter((node) => node.type === "directory")
                .map((node) => (
                  <TreeNode
                    key={node.name}
                    node={node}
                    depth={0}
                    pathPrefix=""
                    onSelectEntity={setSelectedEntity}
                  />
                ))}
            </div>
          </div>
        </div>

        {/* Entity grid */}
        <div className="lg:col-span-3">
          <EntityGrid tree={tree} onSelectEntity={setSelectedEntity} sources={sources} />
        </div>
      </div>
    </div>
  );
}

function TreeNode({
  node,
  depth,
  pathPrefix,
  onSelectEntity,
}: {
  node: LifeTreeNode;
  depth: number;
  pathPrefix: string;
  onSelectEntity: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const currentPath = pathPrefix ? `${pathPrefix}/${node.name}` : node.name;

  if (node.type === "file") return null;

  const hasItemsJson = node.children?.some((c) => c.name === "items.json");
  const subdirs = node.children?.filter((c) => c.type === "directory") ?? [];

  return (
    <div>
      <button
        onClick={() => {
          if (hasItemsJson) {
            onSelectEntity(currentPath);
          } else {
            setExpanded(!expanded);
          }
        }}
        className={cn(
          "flex items-center gap-1.5 w-full text-left py-1.5 px-2 rounded-md text-sm transition-colors",
          hasItemsJson
            ? "hover:bg-accent-bg text-ink hover:text-accent cursor-pointer"
            : "hover:bg-cream text-ink-muted",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {subdirs.length > 0 && !hasItemsJson ? (
          expanded ? (
            <ChevronDown className="w-3 h-3 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 shrink-0" />
          )
        ) : (
          <Circle className={cn("w-2 h-2 shrink-0", hasItemsJson ? "fill-accent text-accent" : "text-ink-faint")} />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {expanded && subdirs.length > 0 && (
        <div>
          {subdirs.map((child) => (
            <TreeNode
              key={child.name}
              node={child}
              depth={depth + 1}
              pathPrefix={currentPath}
              onSelectEntity={onSelectEntity}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EntityGrid({
  tree,
  onSelectEntity,
  sources,
}: {
  tree: LifeTreeNode[];
  onSelectEntity: (path: string) => void;
  sources: import("@/lib/api").DataSource[] | undefined;
}) {
  const entities = useMemo(() => {
    const result: { name: string; path: string; category: string; subcategory: string }[] = [];
    function walk(nodes: LifeTreeNode[], pathParts: string[]) {
      for (const node of nodes) {
        if (node.type !== "directory") continue;
        const currentParts = [...pathParts, node.name];
        if (node.children?.some((c) => c.name === "items.json")) {
          result.push({
            name: node.name,
            path: currentParts.join("/"),
            category: currentParts[0] ?? "",
            subcategory: currentParts.length > 2 ? currentParts[1] : "",
          });
        }
        if (node.children) walk(node.children, currentParts);
      }
    }
    walk(tree, []);
    return result;
  }, [tree]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof entities>();
    for (const entity of entities) {
      if (!map.has(entity.category)) map.set(entity.category, []);
      map.get(entity.category)!.push(entity);
    }
    return map;
  }, [entities]);

  // Build a lookup: category name → description from data-sources.json
  const categoryDescriptions = useMemo(() => {
    const map = new Map<string, string>();
    if (sources) {
      for (const s of sources) {
        // Match "life/areas/" → "areas", "life/projects/" → "projects"
        const match = s.path.match(/^life\/([^/]+)\//);
        if (match && s.description) {
          map.set(match[1], s.description);
        }
      }
    }
    return map;
  }, [sources]);

  const categoryOrder = ["projects", "areas", "resources", "goals", "research", "archives"];

  return (
    <div className="space-y-6">
      {categoryOrder
        .filter((cat) => grouped.has(cat))
        .map((cat) => {
          const items = grouped.get(cat)!;
          const description = categoryDescriptions.get(cat);
          return (
            <div key={cat}>
              <div className="mb-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-ink capitalize">{cat}</h3>
                  <Badge variant="muted">{items.length}</Badge>
                </div>
                {description && (
                  <p className="text-xs text-ink-muted mt-0.5">{description}</p>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {items.map((entity) => (
                  <button
                    key={entity.path}
                    onClick={() => onSelectEntity(entity.path)}
                    className="text-left px-4 py-3 rounded-xl bg-card hover:bg-cream border border-border hover:border-accent/30 transition-colors"
                  >
                    <p className="text-sm font-medium text-ink">{entity.name}</p>
                    {entity.subcategory && (
                      <p className="text-[11px] text-ink-faint mt-0.5">{entity.subcategory}</p>
                    )}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
    </div>
  );
}

// =============================================================================
// Entity Detail View
// =============================================================================

function EntityDetailView({ path, onBack }: { path: string; onBack: () => void }) {
  const { data, error, mutate } = useEntityDetail(path);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  if (error) return <ErrorState message="Failed to load entity" onRetry={() => mutate()} />;
  if (!data) return <PageSkeleton />;

  const categories = [...new Set(data.facts.map((f) => f.category))];
  const filteredFacts = data.facts
    .filter((f) => showSuperseded || f.status === "active")
    .filter((f) => !categoryFilter || f.category === categoryFilter);

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-ink-muted hover:text-accent mb-4 transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Knowledge Graph
      </button>

      <div className="bg-card rounded-xl p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold text-ink capitalize">{data.entity}</h2>
            <p className="text-xs font-mono text-ink-faint mt-1">life/{path}/items.json</p>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <div className="text-center">
              <p className="text-lg font-semibold tabular-nums">{data.totalFacts}</p>
              <p className="text-[11px] text-ink-faint">Total</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold tabular-nums text-healthy">{data.activeFacts}</p>
              <p className="text-[11px] text-ink-faint">Active</p>
            </div>
            {data.supersededFacts > 0 && (
              <div className="text-center">
                <p className="text-lg font-semibold tabular-nums text-ink-faint">{data.supersededFacts}</p>
                <p className="text-[11px] text-ink-faint">Superseded</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setCategoryFilter(null)}
            className={cn(
              "px-2.5 py-1 text-xs rounded-md transition-colors",
              !categoryFilter ? "bg-accent text-white" : "bg-cream text-ink-muted hover:text-ink",
            )}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
              className={cn(
                "px-2.5 py-1 text-xs rounded-md transition-colors",
                categoryFilter === cat ? "bg-accent text-white" : "bg-cream text-ink-muted hover:text-ink",
              )}
            >
              {cat}
            </button>
          ))}
        </div>
        {data.supersededFacts > 0 && (
          <label className="ml-auto flex items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={showSuperseded}
              onChange={(e) => setShowSuperseded(e.target.checked)}
              className="rounded"
            />
            Show superseded
          </label>
        )}
      </div>

      {/* Facts list */}
      <div className="space-y-2">
        {filteredFacts.map((fact) => (
          <FactCard key={fact.id} fact={fact} />
        ))}
        {filteredFacts.length === 0 && (
          <p className="text-sm text-ink-muted py-8 text-center">No facts match the current filters</p>
        )}
      </div>
    </div>
  );
}

function FactCard({ fact }: { fact: FactWithDecay }) {
  const decayColors = {
    hot: "border-l-error",
    warm: "border-l-warning",
    cold: "border-l-border",
  };
  const decayLabels = { hot: "Hot", warm: "Warm", cold: "Cold" };
  const decayBadgeVariants = {
    hot: "error" as const,
    warm: "warning" as const,
    cold: "muted" as const,
  };

  return (
    <div
      className={cn(
        "bg-card rounded-lg px-5 py-4 border border-border border-l-4",
        decayColors[fact.decay],
        fact.status === "superseded" && "opacity-50",
      )}
    >
      <p className={cn("text-sm text-ink leading-relaxed", fact.status === "superseded" && "line-through")}>
        {fact.fact}
      </p>
      <div className="flex items-center gap-2 mt-2.5 flex-wrap">
        <Badge variant={decayBadgeVariants[fact.decay]}>{decayLabels[fact.decay]}</Badge>
        <Badge variant={fact.priority === "high" ? "accent" : "muted"}>{fact.priority}</Badge>
        <Badge variant="muted">{fact.category}</Badge>
        {fact.status === "superseded" && <Badge variant="warning">superseded</Badge>}
        <span className="text-[11px] text-ink-faint ml-auto">
          {fact.timestamp} · {fact.daysSinceAccess === 0 ? "today" : `${fact.daysSinceAccess}d ago`} · {fact.accessCount} reads
        </span>
      </div>
    </div>
  );
}

// =============================================================================
// Daily Notes Tab — simple chronological list
// =============================================================================

function NotesTab() {
  const { data: files, error, mutate } = useMemoryFiles();
  const [fileContent, setFileContent] = useState<{ name: string; content: string } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  async function viewFile(file: MemoryFile) {
    setFileLoading(true);
    try {
      const res = await fetch(`/api/memory/file/${encodeURIComponent(file.name)}`);
      const json = await res.json();
      setFileContent({ name: file.name, content: json.data?.content ?? "Failed to load" });
    } catch {
      setFileContent({ name: file.name, content: "Failed to load" });
    } finally {
      setFileLoading(false);
    }
  }

  if (error) return <ErrorState message="Failed to load daily notes" onRetry={() => mutate()} />;
  if (!files) return <PageSkeleton />;

  return (
    <div className="max-w-3xl">
      <p className="text-sm text-ink-muted mb-4">
        The agent writes a daily markdown log to{" "}
        <span className="font-mono text-accent">memory/</span>.
        These contain session transcripts, call notes, and auto-generated summaries.
      </p>

      <div className="space-y-1">
        {files.map((file) => (
          <button
            key={file.name}
            onClick={() => viewFile(file)}
            className="w-full text-left flex items-center gap-4 px-4 py-3 rounded-lg hover:bg-card border border-transparent hover:border-border transition-colors"
          >
            <FileText className="w-4 h-4 text-ink-faint shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-ink">{file.name.replace(".md", "")}</span>
                <span className="text-[11px] text-ink-faint">{formatRelativeTime(file.modifiedAt)}</span>
                <span className="text-[11px] text-ink-faint">{formatBytes(file.size)}</span>
              </div>
              {file.preview && (
                <p className="text-xs text-ink-muted mt-0.5 truncate">{file.preview}</p>
              )}
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-ink-faint shrink-0" />
          </button>
        ))}
      </div>

      {/* File content modal */}
      {fileContent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm" onClick={() => setFileContent(null)}>
          <div
            className="bg-card rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col m-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h3 className="text-sm font-semibold text-ink">{fileContent.name}</h3>
                <p className="text-xs font-mono text-ink-faint mt-0.5">memory/{fileContent.name}</p>
              </div>
              <button onClick={() => setFileContent(null)} className="text-ink-muted hover:text-ink">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-5">
              {fileLoading ? (
                <div className="skeleton h-64" />
              ) : (
                <pre className="text-sm font-mono text-ink whitespace-pre-wrap break-words leading-relaxed">
                  {fileContent.content}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Agent Context Tab — extraPaths visibility
// =============================================================================

const categoryLabels: Record<string, string> = {
  identity: "Identity",
  policy: "Policy & Rules",
  reference: "Reference",
  contacts: "Contacts",
  tasks: "Tasks",
  skill: "Skills",
  "knowledge-dir": "Knowledge Directories",
  other: "Other",
};

const categoryOrder = ["identity", "policy", "contacts", "tasks", "reference", "skill", "knowledge-dir", "other"];

function AgentContextTab({ agentId }: { agentId?: string }) {
  const agentParam = agentId ? `agent=${encodeURIComponent(agentId)}` : "";
  const { data, error, mutate } = useAgentContext(agentParam);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<AgentContextFileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [showOrphans, setShowOrphans] = useState(false);
  const [showHowItWorks, setShowHowItWorks] = useState(false);

  const grouped = useMemo(() => {
    if (!data) return new Map<string, AgentContextFile[]>();
    const map = new Map<string, AgentContextFile[]>();
    for (const file of data.registered) {
      if (!map.has(file.category)) map.set(file.category, []);
      map.get(file.category)!.push(file);
    }
    return map;
  }, [data]);

  async function viewFile(filePath: string) {
    if (expandedFile === filePath) {
      setExpandedFile(null);
      setFileContent(null);
      return;
    }
    setExpandedFile(filePath);
    setFileLoading(true);
    try {
      const res = await fetch(`/api/memory/agent-context/file?path=${encodeURIComponent(filePath)}`);
      const json = await res.json();
      setFileContent(json.data ?? null);
    } catch {
      setFileContent(null);
    } finally {
      setFileLoading(false);
    }
  }

  if (error) return <ErrorState message="Failed to load agent context" onRetry={() => mutate()} />;
  if (!data) return <PageSkeleton />;

  return (
    <div className="max-w-4xl">
      {/* How it works — at the top for education */}
      <div className="mb-6">
        <button
          onClick={() => setShowHowItWorks(!showHowItWorks)}
          className="flex items-center gap-2 mb-2 text-sm font-semibold text-ink hover:text-accent transition-colors"
        >
          {showHowItWorks ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          How Agent Knowledge Works
        </button>
        {showHowItWorks && (
          <div className="bg-card rounded-xl border border-border p-5 text-sm text-ink-muted leading-relaxed space-y-4 mb-4">
            <div>
              <p className="font-medium text-ink mb-2">Every sweep, the agent loads knowledge in two tiers:</p>
              <div className="space-y-3">
                <div className="bg-cream/50 rounded-lg p-3 border border-border/40">
                  <p className="font-medium text-ink text-xs uppercase tracking-wider mb-1">Tier 1 — Automatic (every turn)</p>
                  <p>
                    Bootstrap files are injected into the system prompt on every turn without the agent doing anything:
                    AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, MEMORY.md.
                    These consume tokens whether or not the agent needs them.
                  </p>
                </div>
                <div className="bg-cream/50 rounded-lg p-3 border border-border/40">
                  <p className="font-medium text-ink text-xs uppercase tracking-wider mb-1">Tier 2 — Agent-initiated (on demand)</p>
                  <p>
                    Everything else is accessed when the agent decides to read it.
                    The agent follows HEARTBEAT.md's instructions to read priority-map.md, auto-resolver.md,
                    contacts.md, and tasks/current.md at the start of each sweep.
                    Skills tell the agent which files to read when invoked.
                    The agent can also call <span className="font-mono text-accent">memory_search</span> to
                    semantically search across all files registered in extraPaths below.
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t border-border/40 pt-3">
              <p className="font-medium text-ink mb-2">What each tab shows:</p>
              <ul className="space-y-2">
                <li>
                  <strong className="text-ink">Agent Context</strong> (this tab) — the files registered in{" "}
                  <span className="font-mono text-accent">openclaw.json → extraPaths</span>.
                  These are what the agent reads explicitly each sweep and what it can find via semantic search.
                  If a file isn't listed here, the agent won't discover it unless specifically told to read it by path.
                </li>
                <li>
                  <strong className="text-ink">What's New</strong> — facts the agent has extracted and saved about people,
                  companies, and projects. These are stored in structured JSON files and maintained by nightly extraction scripts.
                </li>
                <li>
                  <strong className="text-ink">Entities</strong> — browse the same data as What's New, organized by
                  category (people, companies, projects, goals). Click an entity to see all its facts and how recently they were accessed.
                </li>
                <li>
                  <strong className="text-ink">Daily Notes</strong> — markdown summaries of each day's agent sessions, generated
                  automatically from session transcripts. The agent can search these via <span className="font-mono text-accent">memory_search</span>.
                </li>
                <li>
                  <strong className="text-ink">Search</strong> — semantic search across all indexed knowledge
                  (extraPaths files, daily notes, session transcripts).
                </li>
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* Stats bar */}
      <div className="bg-card rounded-xl p-5 border border-border mb-6">
        <div className="flex items-center gap-6 mb-3">
          <div className="text-center">
            <p className="text-lg font-semibold tabular-nums">{data.stats.totalRegistered}</p>
            <p className="text-[11px] text-ink-faint">Registered</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-semibold tabular-nums text-healthy">{data.stats.totalExisting}</p>
            <p className="text-[11px] text-ink-faint">Existing</p>
          </div>
          {data.stats.totalMissing > 0 && (
            <div className="text-center">
              <p className="text-lg font-semibold tabular-nums text-error">{data.stats.totalMissing}</p>
              <p className="text-[11px] text-ink-faint">Missing</p>
            </div>
          )}
          <div className="text-center">
            <p className="text-lg font-semibold tabular-nums">{data.stats.totalDirectories}</p>
            <p className="text-[11px] text-ink-faint">Directories</p>
          </div>
          {data.stats.totalOrphans > 0 && (
            <div className="text-center">
              <p className="text-lg font-semibold tabular-nums text-warning">{data.stats.totalOrphans}</p>
              <p className="text-[11px] text-ink-faint">Orphans</p>
            </div>
          )}
        </div>
        <p className="text-xs text-ink-muted leading-relaxed">
          These files are registered in{" "}
          <span className="font-mono text-accent">openclaw.json → extraPaths</span>.
          The agent can find and search these during sweeps.
          If a file isn't listed here, the agent can only access it by explicit file path — it won't appear in memory search.
        </p>
      </div>

      {/* Registered files by category */}
      <div className="space-y-5 mb-8">
        {categoryOrder
          .filter((cat) => grouped.has(cat))
          .map((cat) => {
            const files = grouped.get(cat)!;
            return (
              <div key={cat}>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-sm font-semibold text-ink">
                    {categoryLabels[cat] ?? cat}
                  </h3>
                  <Badge variant="muted">{files.length}</Badge>
                </div>
                <div className="bg-card rounded-xl border border-border overflow-hidden">
                  {files.map((file, i) => (
                    <div key={file.path}>
                      <div
                        onClick={() => !file.isDirectory && file.exists && viewFile(file.path)}
                        className={cn(
                          "flex items-center gap-3 px-4 py-2.5 transition-colors",
                          i > 0 && "border-t border-border/40",
                          !file.exists && "bg-error/5",
                          !file.isDirectory && file.exists && "cursor-pointer hover:bg-cream/60",
                        )}
                      >
                        {file.isDirectory ? (
                          <Folder className="w-3.5 h-3.5 text-accent shrink-0" />
                        ) : !file.exists ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-error shrink-0" />
                        ) : (
                          <FileText className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-ink font-medium">
                            {file.relativePath}
                          </span>
                          {file.preview && expandedFile !== file.path && (
                            <p className="text-[11px] text-ink-faint truncate mt-0.5">{file.preview}</p>
                          )}
                        </div>
                        {!file.exists && (
                          <Badge variant="error">missing</Badge>
                        )}
                        {file.isDirectory && (
                          <Badge variant="accent">directory</Badge>
                        )}
                        {file.modifiedAt && (
                          <span className="text-[11px] text-ink-faint shrink-0">
                            {formatRelativeTime(file.modifiedAt)}
                          </span>
                        )}
                        {file.size !== undefined && (
                          <span className="text-[11px] text-ink-faint tabular-nums shrink-0">
                            {formatBytes(file.size)}
                          </span>
                        )}
                        {!file.isDirectory && file.exists && (
                          expandedFile === file.path
                            ? <EyeOff className="w-3 h-3 text-ink-faint shrink-0" />
                            : <Eye className="w-3 h-3 text-ink-faint shrink-0" />
                        )}
                      </div>
                      {expandedFile === file.path && (
                        <div className="border-t border-border/40 bg-cream-dark/20 px-4 py-3">
                          {fileLoading ? (
                            <div className="skeleton h-32" />
                          ) : fileContent ? (
                            <pre className="text-xs font-mono text-ink-muted whitespace-pre-wrap overflow-auto max-h-80 leading-relaxed">
                              {fileContent.content}
                            </pre>
                          ) : (
                            <p className="text-xs text-ink-faint">Failed to load file content</p>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
      </div>

      {/* Orphaned files */}
      {data.orphans.length > 0 && (
        <div className="mb-6">
          <button
            onClick={() => setShowOrphans(!showOrphans)}
            className="flex items-center gap-2 mb-3 text-sm font-semibold text-warning hover:text-ink transition-colors"
          >
            {showOrphans ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <AlertTriangle className="w-3.5 h-3.5" />
            Orphaned Files
            <Badge variant="warning">{data.orphans.length}</Badge>
          </button>
          {showOrphans && (
            <div>
              <p className="text-xs text-ink-muted mb-3 leading-relaxed">
                These files exist in{" "}
                <span className="font-mono text-accent">workspace/</span>{" "}
                but aren't registered in extraPaths.
                The agent can read them if explicitly told to, but won't discover them through search.
                To register a file, add its absolute path to{" "}
                <span className="font-mono text-accent">agents.defaults.memorySearch.extraPaths</span>{" "}
                in openclaw.json.
              </p>
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                {data.orphans.map((orphan, i) => (
                  <div
                    key={orphan.path}
                    className={cn(
                      "flex items-center gap-3 px-4 py-2.5",
                      i > 0 && "border-t border-border/40",
                    )}
                  >
                    <EyeOff className="w-3.5 h-3.5 text-warning shrink-0" />
                    <span className="text-sm text-ink font-medium flex-1">{orphan.relativePath}</span>
                    <span className="text-[11px] text-ink-faint">{formatRelativeTime(orphan.modifiedAt)}</span>
                    <span className="text-[11px] text-ink-faint tabular-nums">{formatBytes(orphan.size)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* How it works is now at the top */}
    </div>
  );
}

// =============================================================================
// Search Tab — simplified
// =============================================================================

function SearchTab() {
  const { data: qmd } = useQmdStatus();

  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState("memory");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  async function handleSearch() {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const data = await apiPost<SearchResult[]>("/api/memory/qmd/search", { query, collection });
      setResults(data);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <p className="text-sm text-ink-muted mb-4">
        Search across all memory and knowledge files using semantic + keyword search.
      </p>

      <div className="flex items-center gap-3 mb-6">
        <input
          type="text"
          placeholder="What are you looking for?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          className="flex-1 px-4 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
        />
        {qmd && qmd.collections.length > 1 && (
          <select
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            className="px-3 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            {qmd.collections.map((c) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
        )}
        <button
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className="px-4 py-2.5 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent-muted transition-colors disabled:opacity-50"
        >
          {searching ? "Searching..." : "Search"}
        </button>
      </div>

      {results && (
        <div className="space-y-2">
          {results.length === 0 && (
            <p className="text-sm text-ink-muted py-4 text-center">No results found</p>
          )}
          {results.map((r, i) => (
            <div key={i} className="bg-card rounded-lg border border-border px-4 py-3">
              <p className="text-xs font-mono text-accent mb-1">{r.path}</p>
              <p className="text-sm text-ink line-clamp-2">{r.snippet}</p>
              <div className="mt-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1.5 bg-cream-dark rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full"
                      style={{ width: `${Math.min(100, r.score * 100)}%` }}
                    />
                  </div>
                  <span className="text-[11px] font-mono text-ink-faint">{r.score.toFixed(3)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
