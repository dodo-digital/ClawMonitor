import { useState } from "react";

import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/error-state";
import { PageSkeleton } from "@/components/ui/skeleton";
import {
  useAccessSurface,
  useChannelActivity,
  useSecurityLatest,
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

      <AccessSurfaceSection surface={surface} />

      {activity && activity.byChannel.length > 0 && (
        <ActivitySection channels={activity.byChannel} surface={surface} />
      )}
    </div>
  );
}

// =============================================================================
// Config Health — "Is your config secure?"
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
  return (
    <section>
      <SectionHeader title="Config Health" />

      {compliance ? (
        <div className="space-y-3">
          {/* Score bar */}
          <div className={cn(
            "flex items-center gap-4 rounded-xl border p-4",
            compliance.score >= 80 ? "bg-healthy/5 border-healthy/20" : "bg-error/5 border-error/20",
          )}>
            {compliance.score >= 80
              ? <ShieldCheck className="w-6 h-6 text-healthy shrink-0" />
              : <ShieldAlert className="w-6 h-6 text-error shrink-0" />}
            <div className="flex-1">
              <span className={cn("text-2xl font-bold tabular-nums", compliance.score >= 80 ? "text-healthy" : "text-error")}>
                {compliance.score}
              </span>
              <span className="text-sm text-ink-muted">/100</span>
              <p className="text-xs text-ink-faint mt-0.5">
                Scanned {formatRelativeTime(compliance.scannedAt)}
              </p>
            </div>
            <button
              onClick={onScan}
              disabled={scanning}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-card border border-border text-ink rounded-lg hover:bg-cream-dark/40 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={cn("w-3 h-3", scanning && "animate-spin")} />
              {scanning ? "Scanning" : "Re-scan"}
            </button>
          </div>

          {/* Checklist */}
          <div className="bg-card rounded-xl border border-border divide-y divide-border/40">
            <ChecklistItem label="Exec security" sublabel="Can agents run commands safely?" category={compliance.breakdown.execPosture} />
            <ChecklistItem label="Secret exposure" sublabel="API keys leaked in tool outputs?" category={compliance.breakdown.credentialExposure} />
            <ChecklistItem label="Skill files" sublabel="Have installed skills been tampered with?" category={compliance.breakdown.skillIntegrity} />
            <ChecklistItem label="Auth profiles" sublabel="API keys configured and valid?" category={compliance.breakdown.authHealth} />
          </div>
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border p-6 text-center">
          <p className="text-sm text-ink-muted">No scan yet.</p>
          <button onClick={onScan} disabled={scanning} className="mt-2 px-3 py-1.5 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50">
            {scanning ? "Scanning..." : "Run first scan"}
          </button>
        </div>
      )}
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
        <div className="flex-1 min-w-0">
          <span className="text-sm text-ink font-medium">{label}</span>
          <span className="text-xs text-ink-faint ml-2 hidden sm:inline">{sublabel}</span>
        </div>
        <span className={cn("text-xs font-bold tabular-nums shrink-0", color)}>{category.score}/{category.max}</span>
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
// Access Surface — "What doors are open?"
// =============================================================================

function AccessSurfaceSection({ surface }: { surface: import("@/lib/api").AccessSurface }) {
  const highRiskChannels = surface.channels.filter((c) => c.enabled && c.risk === "high");

  return (
    <section>
      <SectionHeader title="Access Surface" />

      {/* Alert banner if any high-risk channels */}
      {highRiskChannels.length > 0 && (
        <div className="bg-error/8 border border-error/20 rounded-xl px-4 py-3 mb-4">
          <p className="text-sm text-error font-medium">
            {highRiskChannels.length} channel{highRiskChannels.length > 1 ? "s" : ""} with open access
          </p>
          <p className="text-xs text-ink-muted mt-0.5">
            {highRiskChannels.map((c) => c.name).join(", ")} — anyone can message the agent through {highRiskChannels.length > 1 ? "these" : "this"}
          </p>
        </div>
      )}

      {/* Channels */}
      <div className="bg-card rounded-xl border border-border divide-y divide-border/40 mb-4">
        {surface.channels.map((ch) => (
          <ChannelRow key={ch.name} channel={ch} />
        ))}
      </div>

      {/* Webhooks */}
      {surface.webhooks.length > 0 && (
        <div className="bg-card rounded-xl border border-border divide-y divide-border/40 mb-4">
          <div className="px-4 py-2.5 text-xs font-semibold text-ink uppercase tracking-wider bg-cream-dark/30">
            Webhooks
            {!surface.hooksEnabled && <Badge variant="muted" className="ml-2">disabled</Badge>}
          </div>
          {surface.webhooks.map((wh) => (
            <WebhookRow key={wh.path} webhook={wh} />
          ))}
        </div>
      )}

      {/* Gateway config — inline, tighter */}
      <div className="bg-card rounded-xl border border-border px-4 py-3">
        <div className="text-xs font-semibold text-ink uppercase tracking-wider mb-2">Gateway</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-1.5 gap-x-4 text-xs">
          <GatewayField label="Bind" value={surface.gateway.bind} good={surface.gateway.bind === "127.0.0.1" || surface.gateway.bind === "loopback"} />
          <GatewayField label="Auth" value={surface.gateway.authMode} good={surface.gateway.authMode === "token"} />
          <GatewayField label="Tailscale" value={surface.gateway.tailscale ? "enabled" : "off"} />
          <GatewayField label="Exec" value={surface.execSecurity} good={surface.execSecurity === "full"} />
          <GatewayField label="Agents" value={String(surface.agentCount)} />
          <GatewayField label="Bindings" value={String(surface.totalBindings)} />
        </div>
      </div>
    </section>
  );
}

function GatewayField({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-ink-faint">{label}</span>
      <span className={cn("font-medium", good === true ? "text-healthy" : good === false ? "text-error" : "text-ink")}>{value}</span>
    </div>
  );
}

function ChannelRow({ channel }: { channel: AccessChannel }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex items-center gap-3 w-full px-4 py-3 text-left transition-colors hover:bg-cream-dark/30",
          channel.risk === "high" && channel.enabled && "bg-error/5",
        )}
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
        <div className="px-4 pb-3 ml-7 space-y-1.5 text-xs text-ink-muted">
          <div>
            <strong>DM policy:</strong> {channel.dmPolicy}
            {channel.dmPolicy === "open" && <span className="text-error ml-1">— anyone can message the agent</span>}
            {channel.dmPolicy === "allowlist" && channel.allowedUsers != null && (
              <span> — {channel.allowedUsers} approved user{channel.allowedUsers !== 1 ? "s" : ""}</span>
            )}
            {channel.dmPolicy === "pairing" && <span className="text-warning ml-1">— anyone can request, requires approval</span>}
          </div>
          <div><strong>Group policy:</strong> {channel.groupPolicy}</div>
          <div>
            <strong>Agents:</strong>{" "}
            {channel.boundAgents.length > 0 ? channel.boundAgents.join(", ") : "default"}
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
// Activity — "What's happening right now?"
// =============================================================================

function ActivitySection({ channels, surface }: { channels: ChannelActivity[]; surface: import("@/lib/api").AccessSurface }) {
  const riskMap = new Map(surface.channels.map((c) => [c.name, c.risk]));

  return (
    <section>
      <SectionHeader title="Channel Activity" />

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

// =============================================================================
// Shared
// =============================================================================

function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="text-xs font-semibold text-ink-faint uppercase tracking-wider mb-3">{title}</h2>
  );
}
