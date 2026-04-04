import { useState, useMemo } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { usePlugins, type Plugin } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Search,
  Plug,
  MessageSquare,
  Globe,
  Mic,
  Image,
  Cpu,
  Wrench,
  Server,
  Package,
  ChevronDown,
  ChevronRight,
  Check,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Category metadata
// ---------------------------------------------------------------------------

type CategoryMeta = {
  label: string;
  icon: typeof Plug;
  description: string;
  defaultExpanded: boolean;
};

const CATEGORIES: Record<string, CategoryMeta> = {
  channel:  { label: "Channels",         icon: MessageSquare, description: "Messaging integrations", defaultExpanded: true },
  runtime:  { label: "Runtime",          icon: Cpu,           description: "Core infrastructure",    defaultExpanded: true },
  search:   { label: "Search & Browse",  icon: Globe,         description: "Web search and fetch",   defaultExpanded: true },
  speech:   { label: "Speech",           icon: Mic,           description: "Voice and audio",        defaultExpanded: true },
  image:    { label: "Image Generation", icon: Image,         description: "Visual content creation", defaultExpanded: true },
  utility:  { label: "Utilities",        icon: Wrench,        description: "Built-in tools",         defaultExpanded: true },
  provider: { label: "Model Providers",  icon: Server,        description: "LLM backends",           defaultExpanded: false },
  media:    { label: "Media",            icon: Image,         description: "Media understanding",    defaultExpanded: true },
  other:    { label: "Other",            icon: Package,       description: "Uncategorized",          defaultExpanded: true },
};

const CATEGORY_ORDER = ["channel", "runtime", "search", "speech", "image", "media", "utility", "other", "provider"];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Plugins() {
  const { data, error, mutate } = usePlugins();
  const [search, setSearch] = useState("");
  const [showDisabled, setShowDisabled] = useState(false);

  const grouped = useMemo(() => {
    if (!data) return new Map<string, Plugin[]>();

    const filtered = data.plugins.filter((p) => {
      if (!showDisabled && !p.enabled) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        p.id.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.capabilities.some((c) => c.toLowerCase().includes(q))
      );
    });

    const groups = new Map<string, Plugin[]>();
    for (const p of filtered) {
      const list = groups.get(p.category) ?? [];
      list.push(p);
      groups.set(p.category, list);
    }
    return groups;
  }, [data, search, showDisabled]);

  if (error) return <ErrorState message="Failed to load plugins" onRetry={() => mutate()} />;
  if (!data) return <PageSkeleton />;

  const visibleCount = Array.from(grouped.values()).reduce((s, g) => s + g.length, 0);

  return (
    <div>
      <PageHeader
        title="Plugins"
        description={`${data.enabled} active of ${data.total} installed`}
      />

      {/* Controls */}
      <div className="flex items-center gap-3 mb-5">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-faint" />
          <input
            type="text"
            placeholder="Search plugins..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-cream-dark border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent/40 placeholder:text-ink-faint"
          />
        </div>
        {search && (
          <button onClick={() => setSearch("")} className="text-xs text-accent hover:underline">
            Clear
          </button>
        )}
        <button
          onClick={() => setShowDisabled((d) => !d)}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors",
            showDisabled
              ? "bg-accent-bg border-accent/30 text-accent"
              : "bg-card border-border text-ink-muted hover:bg-cream-dark",
          )}
        >
          {showDisabled ? "Showing all" : "Active only"}
          <span className="text-ink-faint">({showDisabled ? data.total : data.enabled})</span>
        </button>
      </div>

      {visibleCount === 0 && (
        <div className="py-16 text-center text-sm text-ink-muted">
          No plugins match your search
        </div>
      )}

      {/* Plugin groups */}
      <div className="space-y-2">
        {CATEGORY_ORDER.filter((cat) => grouped.has(cat)).map((cat) => (
          <CategorySection
            key={cat}
            category={cat}
            plugins={grouped.get(cat)!}
            meta={CATEGORIES[cat] ?? CATEGORIES.other}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category section (collapsible)
// ---------------------------------------------------------------------------

function CategorySection({
  category,
  plugins,
  meta,
}: {
  category: string;
  plugins: Plugin[];
  meta: CategoryMeta;
}) {
  const [expanded, setExpanded] = useState(meta.defaultExpanded);
  const enabledCount = plugins.filter((p) => p.enabled).length;
  const Icon = meta.icon;

  return (
    <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-cream-dark/30 transition-colors"
      >
        <Icon className="w-4 h-4 text-ink-muted shrink-0" />
        <div className="flex-1 text-left min-w-0">
          <span className="text-sm font-medium text-ink">{meta.label}</span>
          <span className="ml-2 text-xs text-ink-faint">{meta.description}</span>
        </div>
        <span className="text-xs text-ink-faint tabular-nums">
          {enabledCount}/{plugins.length}
        </span>
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-ink-faint shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-ink-faint shrink-0" />}
      </button>

      {expanded && (
        <div className="border-t border-border/40">
          {category === "provider" ? (
            <ProviderGrid plugins={plugins} />
          ) : (
            <div className="divide-y divide-border/30">
              {plugins.map((p) => (
                <PluginRow key={p.id} plugin={p} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual plugin row (for non-provider plugins)
// ---------------------------------------------------------------------------

function PluginRow({ plugin }: { plugin: Plugin }) {
  return (
    <div className={cn("px-4 py-2.5 flex items-start gap-3", !plugin.enabled && "opacity-50")}>
      {/* Status indicator */}
      <div className="mt-1 shrink-0">
        {plugin.enabled ? (
          <span className="flex items-center justify-center w-4 h-4 rounded-full bg-healthy/15">
            <Check className="w-2.5 h-2.5 text-healthy" />
          </span>
        ) : (
          <span className="flex items-center justify-center w-4 h-4 rounded-full bg-cream-dark">
            <X className="w-2.5 h-2.5 text-ink-faint" />
          </span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        {/* Name + version + origin */}
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-ink">{cleanName(plugin.name)}</span>
          {plugin.version && (
            <span className="text-[10px] text-ink-faint font-mono">{plugin.version}</span>
          )}
          {plugin.origin !== "bundled" && (
            <Badge variant={plugin.origin === "global" ? "accent" : "warning"}>
              {plugin.origin}
            </Badge>
          )}
        </div>

        {/* Description */}
        <p className="text-xs text-ink-muted leading-relaxed">{plugin.description}</p>

        {/* Capabilities */}
        {plugin.capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {plugin.capabilities.map((cap) => (
              <span
                key={cap}
                className="text-[10px] px-1.5 py-0.5 rounded bg-cream-dark text-ink-faint font-medium"
              >
                {cap}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact provider grid (providers are many, show them dense)
// ---------------------------------------------------------------------------

function ProviderGrid({ plugins }: { plugins: Plugin[] }) {
  const sorted = [...plugins].sort((a, b) => {
    // Enabled first, then alphabetical
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-px bg-border/30">
      {sorted.map((p) => (
        <div
          key={p.id}
          className={cn(
            "bg-card px-3 py-2 flex items-center gap-2",
            !p.enabled && "opacity-40",
          )}
        >
          {p.enabled ? (
            <Check className="w-3 h-3 text-healthy shrink-0" />
          ) : (
            <X className="w-3 h-3 text-ink-faint shrink-0" />
          )}
          <div className="min-w-0">
            <span className="text-xs font-medium text-ink truncate block">{p.id}</span>
            {p.version && (
              <span className="text-[10px] text-ink-faint font-mono">{p.version}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip @openclaw/ prefix and -plugin/-provider suffix for cleaner display */
function cleanName(name: string): string {
  return name
    .replace(/^@openclaw\//, "")
    .replace(/-plugin$/, "")
    .replace(/-provider$/, "");
}
