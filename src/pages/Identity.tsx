import { useState, useEffect } from "react";
import { useParams } from "react-router";
import { PageHeader } from "@/components/layout/PageHeader";
import { useBootstrapFiles, apiPut, type BootstrapFile } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { formatNumber, cn } from "@/lib/utils";
import { Save, FileText, Shield } from "lucide-react";

export function Identity() {
  const { agentId } = useParams<{ agentId?: string }>();
  const agentParam = agentId ? `agent=${encodeURIComponent(agentId)}` : "";
  const { data, error, mutate } = useBootstrapFiles(agentParam);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const selectedFile = data?.files.find((f) => f.name === selected);

  // Load file content when selection changes
  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    const qs = agentParam ? `?${agentParam}` : "";
    fetch(`/api/bootstrap/file/${selected}${qs}`)
      .then((r) => r.json())
      .then((json) => {
        setContent(json.data?.content ?? "");
        setDirty(false);
      })
      .catch(() => setContent("Failed to load file"))
      .finally(() => setLoading(false));
  }, [selected, agentParam]);

  // Auto-select first file
  useEffect(() => {
    if (data && !selected) {
      setSelected(data.files[0]?.name ?? null);
    }
  }, [data, selected]);

  async function handleSave() {
    if (!selected || !dirty) return;
    setSaving(true);
    try {
      const qs = agentParam ? `?${agentParam}` : "";
      await apiPut(`/api/bootstrap/file/${selected}${qs}`, { content });
      setDirty(false);
      mutate();
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setSaving(false);
    }
  }

  if (error) return <ErrorState message="Failed to load identity files" onRetry={() => mutate()} />;
  if (!data) return <PageSkeleton />;

  const totalPct = (data.totalBudget.used / data.totalBudget.max) * 100;

  return (
    <div>
      <PageHeader section="05" title="Identity Files" description="Bootstrap files injected into every agent session" />

      {/* Total budget */}
      <div className="bg-card rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-ink">Total Budget</span>
          <span className="text-sm text-ink-muted tabular-nums">
            {formatNumber(data.totalBudget.used)} / {formatNumber(data.totalBudget.max)} chars
          </span>
        </div>
        <ProgressBar value={totalPct} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* File list */}
        <div className="space-y-1.5">
          {data.files.map((file) => (
            <FileItem
              key={file.name}
              file={file}
              active={selected === file.name}
              onClick={() => setSelected(file.name)}
            />
          ))}
        </div>

        {/* Editor */}
        <div className="lg:col-span-2 bg-card rounded-xl overflow-hidden flex flex-col">
          {selectedFile && (
            <>
              <div className="flex items-center justify-between px-5 py-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-ink-muted" />
                  <span className="text-sm font-semibold text-ink">{selectedFile.name}</span>
                  <Badge variant="muted">#{selectedFile.injectionOrder}</Badge>
                  {selectedFile.loadInSubagent && <Badge variant="accent">subagent</Badge>}
                  {selectedFile.specialInstruction && (
                    <Badge variant="warning">
                      <Shield className="w-3 h-3 mr-1" />
                      persona
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-ink-faint tabular-nums">
                    {formatNumber(content.length)} / {formatNumber(selectedFile.budgetMax)} chars
                  </span>
                  <button
                    onClick={handleSave}
                    disabled={!dirty || saving}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors",
                      dirty
                        ? "bg-accent text-white hover:bg-accent-muted"
                        : "bg-cream-dark text-ink-faint cursor-not-allowed",
                    )}
                  >
                    <Save className="w-3.5 h-3.5" />
                    {saving ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
              <div className="flex-1 min-h-0">
                {loading ? (
                  <div className="skeleton h-full m-4" />
                ) : (
                  <textarea
                    value={content}
                    onChange={(e) => {
                      setContent(e.target.value);
                      setDirty(true);
                    }}
                    className="w-full h-[calc(100vh-380px)] p-5 text-sm font-mono text-ink bg-transparent resize-none focus:outline-none leading-relaxed"
                    spellCheck={false}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FileItem({ file, active, onClick }: { file: BootstrapFile; active: boolean; onClick: () => void }) {
  const pct = (file.sizeChars / file.budgetMax) * 100;

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-4 py-3 rounded-xl transition-all",
        active ? "bg-card shadow-sm ring-1 ring-accent/20" : "hover:bg-card/60",
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-accent">#{file.injectionOrder}</span>
          <span className="text-sm font-medium text-ink">{file.name}</span>
        </div>
      </div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] text-ink-faint tabular-nums">
          {formatNumber(file.sizeChars)} / {formatNumber(file.budgetMax)}
        </span>
      </div>
      <ProgressBar value={pct} size="sm" />
    </button>
  );
}
