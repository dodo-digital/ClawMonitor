import { useState } from "react";

import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/error-state";
import { PageSkeleton } from "@/components/ui/skeleton";
import {
  useAccessSurface,
  useChannelActivity,
  useSecurityLatest,
  apiPost,
  type AccessChannel,
  type AccessWebhook,
  type ChannelActivity,
  type SecurityComplianceReport,
  type SecurityCategoryScore,
} from "@/lib/api";
import { cn, formatRelativeTime, formatNumber } from "@/lib/utils";
import {
  ShieldCheck,
  ShieldAlert,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Minus,
  RefreshCw,
} from "lucide-react";

export function Security() {
  const { data: surface, error: surfaceErr, mutate: retrySurface } = useAccessSurface();
  const { data: activity } = useChannelActivity();
  const { data: compliance, mutate: retryCompliance } = useSecurityLatest();
  const [scanning, setScanning] = useState(false);

  if (surfaceErr) return <ErrorState message="Failed to load security data" onRetry={() => retrySurface()} />;
  if (!surface) return <PageSkeleton />;

  return (
    <div className="space-y-8 max-w-3xl">
      <PageHeader title="Security" description="Configuration, access, and activity" />

      <ConfigHealthSection
        compliance={compliance ?? undefined}
        scanning={scanning}
        onScan={async () => {
          setScanning(true);
          try { await fetch("/api/security/scan"); await retryCompliance(); } catch {} finally { setScanning(false); }
        }}
      />

      <AccessSurfaceSection surface={surface} onPolicyChanged={retrySurface} />

      {activity && activity.byChannel.length > 0 && (
        <ActivitySection channels={activity.byChannel} surface={surface} />
      )}
    </div>
  );
}

// =============================================================================
// Config Health
// =============================================================================

function ConfigHealthSection({
  compliance,
  scanning,
  onScan,
}: {
  compliance?: SecurityComplianceReport;
  scanning: boolean;
  onScan: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section>
      <div className="bg-card rounded-xl border border-border">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-3 w-full px-4 py-3 text-left hover:bg-cream-dark/30 transition-colors"
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5 text-ink-faint" /> : <ChevronRight className="w-3.5 h-3.5 text-ink-faint" />}

          {compliance ? (
            <>
              {compliance.score >= 80
                ? <ShieldCheck className="w-4 h-4 text-healthy" />
                : <ShieldAlert className="w-4 h-4 text-error" />}
              <span className={cn("text-sm font-bold tabular-nums", compliance.score >= 80 ? "text-healthy" : compliance.score >= 50 ? "text-warning" : "text-error")}>
                {compliance.score}/100
              </span>
              <span className="text-xs text-ink-faint">
                Scanned {formatRelativeTime(compliance.scannedAt)}
              </span>
            </>
          ) : (
            <span className="text-sm text-ink-muted">No scan run yet</span>
          )}

          <button
            onClick={(e) => { e.stopPropagation(); onScan(); }}
            disabled={scanning}
            className="ml-auto flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-cream-dark/60 text-ink-muted rounded-md hover:bg-cream-dark transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("w-3 h-3", scanning && "animate-spin")} />
            {scanning ? "Scanning" : "Scan"}
          </button>
        </button>

        {expanded && compliance && (
          <div className="border-t border-border/40 divide-y divide-border/40">
            <ChecklistItem label="Exec security" sublabel="Can agents run commands safely?" category={compliance.breakdown.execPosture} />
            <ChecklistItem label="Secret exposure" sublabel="API keys leaked in tool outputs?" category={compliance.breakdown.credentialExposure} />
            <ChecklistItem label="Skill files" sublabel="Have installed skills been tampered with?" category={compliance.breakdown.skillIntegrity} />
            <ChecklistItem label="Auth profiles" sublabel="API keys configured and valid?" category={compliance.breakdown.authHealth} />
          </div>
        )}
      </div>
    </section>
  );
}

function ChecklistItem({ label, sublabel, category }: { label: string; sublabel: string; category: SecurityCategoryScore }) {
  const pct = (category.score / category.max) * 100;
  const perfect = pct === 100;
  const bad = pct < 50;
  const StatusIcon = perfect ? Check : bad ? X : Minus;
  const color = perfect ? "text-healthy" : bad ? "text-error" : "text-warning";

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <StatusIcon className={cn("w-3.5 h-3.5 shrink-0", color)} />
        <span className="text-sm text-ink">{label}</span>
        <span className="text-xs text-ink-faint">{sublabel}</span>
        <span className={cn("ml-auto text-xs font-bold tabular-nums", color)}>{category.score}/{category.max}</span>
      </div>
      {!perfect && category.details.length > 0 && (
        <div className="mt-1.5 ml-6 space-y-0.5">
          {category.details.map((d, i) => (
            <p key={i} className="text-xs text-ink-muted">{d}</p>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Access Surface
// =============================================================================

function AccessSurfaceSection({ surface, onPolicyChanged }: { surface: import("@/lib/api").AccessSurface; onPolicyChanged: () => void }) {
  return (
    <section>
      <h2 className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-3">Access Surface</h2>

      {/* Channels */}
      <div className="bg-card rounded-xl border border-border divide-y divide-border/40 mb-4">
        {surface.channels.map((ch) => (
          <ChannelRow key={ch.name} channel={ch} onPolicyChanged={onPolicyChanged} />
        ))}
      </div>

      {/* Webhooks */}
      {surface.webhooks.length > 0 && (
        <div className="bg-card rounded-xl border border-border divide-y divide-border/40 mb-4">
          <div className="px-4 py-2 text-[11px] font-semibold text-ink-faint uppercase tracking-wider">
            Webhooks
            {!surface.hooksEnabled && <Badge variant="muted" className="ml-2">disabled</Badge>}
          </div>
          {surface.webhooks.map((wh) => (
            <WebhookRow key={wh.path} webhook={wh} />
          ))}
        </div>
      )}

      {/* Gateway */}
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
        <GwField label="Bind" value={surface.gateway.bind} good={surface.gateway.bind === "127.0.0.1" || surface.gateway.bind === "loopback"} />
        <GwField label="Auth" value={surface.gateway.authMode} good={surface.gateway.authMode === "token"} />
        <GwField label="Tailscale" value={surface.gateway.tailscale ? "yes" : "no"} />
        <GwField label="Exec" value={surface.execSecurity} good={surface.execSecurity === "full"} />
        <GwField label="Agents" value={String(surface.agentCount)} />
        <GwField label="Bindings" value={String(surface.totalBindings)} />
      </div>
    </section>
  );
}

function GwField({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <span className="text-ink-faint">
      {label}: <strong className={cn(good === true ? "text-healthy" : good === false ? "text-error" : "text-ink-muted")}>{value}</strong>
    </span>
  );
}

function ChannelRow({ channel, onPolicyChanged }: { channel: AccessChannel; onPolicyChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [changing, setChanging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function changePolicy(newPolicy: string) {
    setChanging(true);
    setToast(null);
    try {
      const result = await apiPost<{ note: string }>("/api/security/channel-policy", {
        channel: channel.name,
        dmPolicy: newPolicy,
      });
      setToast(result.note);
      onPolicyChanged();
    } catch (err) {
      setToast(`Failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setChanging(false);
    }
  }

  return (
    <div className={channel.risk === "high" && channel.enabled ? "bg-error/5" : ""}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-3 w-full px-4 py-3 text-left hover:bg-cream-dark/30 transition-colors"
      >
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-ink-faint shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-ink-faint shrink-0" />}

        <span className="text-sm font-medium text-ink capitalize">{channel.name}</span>

        {!channel.enabled ? (
          <Badge variant="muted">off</Badge>
        ) : channel.risk === "high" ? (
          <Badge variant="error">open</Badge>
        ) : channel.risk === "medium" ? (
          <Badge variant="warning">pairing</Badge>
        ) : (
          <Badge variant="accent">restricted</Badge>
        )}

        <div className="ml-auto flex items-center gap-3 text-xs text-ink-faint">
          {channel.allowedUsers != null && <span>{channel.allowedUsers} user{channel.allowedUsers !== 1 ? "s" : ""}</span>}
          {channel.boundAgents.length > 0 && <span>{channel.boundAgents.length} agent{channel.boundAgents.length !== 1 ? "s" : ""}</span>}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 ml-7 space-y-3">
          {/* Explanation */}
          <p className="text-xs text-ink-muted leading-relaxed">{channel.explanation}</p>

          {/* Policy picker — always visible for enabled channels */}
          {channel.enabled && (
            <div className="bg-cream-dark/40 rounded-lg px-3 py-2.5">
              <p className="text-[11px] text-ink-faint mb-2">DM policy</p>
              <div className="flex items-center gap-1.5 flex-wrap">
                {(["allowlist", "pairing", "open", "closed"] as const).map((policy) => (
                  <button
                    key={policy}
                    onClick={(e) => { e.stopPropagation(); changePolicy(policy); }}
                    disabled={changing || channel.dmPolicy === policy}
                    className={cn(
                      "px-2.5 py-1 text-xs rounded-md transition-colors disabled:opacity-50",
                      channel.dmPolicy === policy
                        ? "bg-accent text-white font-medium"
                        : "bg-card border border-border text-ink-muted hover:bg-cream-dark/60",
                    )}
                  >
                    {policy === "allowlist" ? "Allowlist" : policy === "pairing" ? "Pairing" : policy === "open" ? "Open" : "Closed"}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-ink-faint mt-1.5">
                {channel.dmPolicy === "allowlist" && "Only pre-approved users. Most restrictive."}
                {channel.dmPolicy === "pairing" && "Anyone can request, you approve. Moderate."}
                {channel.dmPolicy === "open" && "Anyone can message. Least restrictive."}
                {channel.dmPolicy === "closed" && "No DMs. Agent only works in groups."}
              </p>
            </div>
          )}

          {/* Toast */}
          {toast && (
            <p className="text-xs text-ink-muted bg-cream-dark/30 rounded px-2 py-1.5">{toast}</p>
          )}

          {/* Details */}
          <div className="text-xs text-ink-faint space-y-0.5">
            <div>Group policy: <strong className="text-ink-muted">{channel.groupPolicy}</strong></div>
            <div>Agents: <strong className="text-ink-muted">{channel.boundAgents.length > 0 ? channel.boundAgents.join(", ") : "default"}</strong></div>
          </div>
        </div>
      )}
    </div>
  );
}

function WebhookRow({ webhook }: { webhook: AccessWebhook }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 text-xs">
      <span className="font-mono text-ink">{webhook.path}</span>
      <span className="text-ink-faint">{webhook.name}</span>
      <span className="ml-auto">
        {webhook.hasToken
          ? <span className="text-healthy">authenticated</span>
          : <span className="text-error font-medium">no auth</span>}
      </span>
    </div>
  );
}

// =============================================================================
// Channel Activity
// =============================================================================

function ActivitySection({ channels, surface }: { channels: ChannelActivity[]; surface: import("@/lib/api").AccessSurface }) {
  const riskMap = new Map(surface.channels.map((c) => [c.name, c.risk]));

  return (
    <section>
      <h2 className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-3">Channel Activity</h2>

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="grid grid-cols-[1fr_65px_65px_65px_95px] gap-2 px-4 py-2 border-b border-border text-[10px] uppercase tracking-wider text-ink-faint">
          <span>Channel</span>
          <span className="text-right">Sessions</span>
          <span className="text-right">Messages</span>
          <span className="text-right">Tools</span>
          <span className="text-right">Last active</span>
        </div>

        {channels.map((ch) => {
          const risk = riskMap.get(ch.channel);
          const isHighRiskActive = risk === "high" && ch.sessions24h > 0;
          const inactive = ch.sessions7d === 0;

          return (
            <div
              key={ch.channel}
              className={cn(
                "grid grid-cols-[1fr_65px_65px_65px_95px] gap-2 px-4 py-2.5 border-b border-border/40 last:border-b-0",
                isHighRiskActive && "bg-error/5",
                inactive && "opacity-35",
              )}
            >
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink capitalize">{ch.channel}</span>
                {isHighRiskActive && <span className="text-[10px] text-error font-medium">open</span>}
              </span>
              <span className="text-xs text-ink-muted text-right tabular-nums">
                {ch.sessions24h}<span className="text-ink-faint">/{ch.sessions7d}</span>
              </span>
              <span className="text-xs text-ink-muted text-right tabular-nums">
                {formatNumber(ch.messages24h)}<span className="text-ink-faint">/{formatNumber(ch.messages7d)}</span>
              </span>
              <span className="text-xs text-ink-muted text-right tabular-nums">
                {formatNumber(ch.toolCalls24h)}<span className="text-ink-faint">/{formatNumber(ch.toolCalls7d)}</span>
              </span>
              <span className="text-xs text-ink-faint text-right">
                {ch.lastActivity ? formatRelativeTime(ch.lastActivity) : "—"}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-ink-faint mt-1.5">24h / 7d totals</p>
    </section>
  );
}
