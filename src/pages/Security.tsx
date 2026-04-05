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
  Globe,
  Webhook,
  Server,
  Activity,
} from "lucide-react";

export function Security() {
  const { data: surface, error: surfaceErr, mutate: retrySurface } = useAccessSurface();
  const { data: activity, error: activityErr } = useChannelActivity();
  const { data: compliance, mutate: retryCompliance } = useSecurityLatest();
  const [scanning, setScanning] = useState(false);

  if (surfaceErr) return <ErrorState message="Failed to load security data" onRetry={() => retrySurface()} />;
  if (!surface) return <PageSkeleton />;

  return (
    <div className="space-y-8 max-w-3xl">
      <PageHeader
        title="Security"
        description="Who has access, what's flowing through, and is the system configured safely?"
      />

      {/* Section 1: Access Surface */}
      <AccessSurfaceSection surface={surface} />

      {/* Section 2: Activity */}
      {activity && <ActivitySection channels={activity.byChannel} surface={surface} />}
      {activityErr && <p className="text-xs text-error">Failed to load activity data</p>}

      {/* Section 3: Config Health */}
      <ConfigHealthSection
        compliance={compliance ?? undefined}
        scanning={scanning}
        onScan={async () => {
          setScanning(true);
          try { await fetch("/api/security/scan"); await retryCompliance(); } catch {} finally { setScanning(false); }
        }}
      />
    </div>
  );
}

// =============================================================================
// Section 1: Access Surface
// =============================================================================

function AccessSurfaceSection({ surface }: { surface: import("@/lib/api").AccessSurface }) {
  return (
    <section>
      <SectionHeader icon={<Globe className="w-4 h-4" />} title="Access Surface" subtitle="What doors are open into this system?" />

      {/* Channels */}
      <div className="bg-card rounded-xl border border-border divide-y divide-border/40 mb-4">
        {surface.channels.map((ch) => (
          <ChannelRow key={ch.name} channel={ch} />
        ))}
        {surface.channels.length === 0 && (
          <div className="px-4 py-6 text-sm text-ink-muted text-center">No channels configured</div>
        )}
      </div>

      {/* Webhooks */}
      {surface.webhooks.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Webhook className="w-3.5 h-3.5 text-ink-faint" />
            <span className="text-xs font-semibold text-ink-faint uppercase tracking-wider">
              Webhook Endpoints
            </span>
            {!surface.hooksEnabled && <Badge variant="muted">disabled</Badge>}
          </div>
          <div className="bg-card rounded-xl border border-border divide-y divide-border/40">
            {surface.webhooks.map((wh) => (
              <WebhookRow key={wh.path} webhook={wh} />
            ))}
          </div>
        </div>
      )}

      {/* Gateway summary */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-faint">
        <span>Gateway bind: <strong className="text-ink-muted">{surface.gateway.bind}</strong></span>
        <span>Auth: <strong className="text-ink-muted">{surface.gateway.authMode}</strong></span>
        <span>Tailscale: <strong className="text-ink-muted">{surface.gateway.tailscale ? "yes" : "no"}</strong></span>
        <span>Exec: <strong className="text-ink-muted">{surface.execSecurity}</strong></span>
        <span>Agents: <strong className="text-ink-muted">{surface.agentCount}</strong></span>
        <span>Bindings: <strong className="text-ink-muted">{surface.totalBindings}</strong></span>
      </div>
    </section>
  );
}

function ChannelRow({ channel }: { channel: AccessChannel }) {
  const [expanded, setExpanded] = useState(false);
  const riskColor = channel.risk === "high" ? "text-error" : channel.risk === "medium" ? "text-warning" : "text-healthy";
  const riskBg = channel.risk === "high" ? "bg-error/8" : "";

  return (
    <div className={riskBg}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-3 w-full px-4 py-3 text-left hover:bg-cream-dark/30 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-ink-faint shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-ink-faint shrink-0" />}

        <span className="text-sm font-medium text-ink capitalize">{channel.name}</span>

        {!channel.enabled && <Badge variant="muted">disabled</Badge>}
        {channel.enabled && (
          <span className={cn("text-xs font-medium", riskColor)}>
            {channel.risk} risk
          </span>
        )}

        <span className="ml-auto text-xs text-ink-faint">
          DM: <strong className={cn(channel.dmPolicy === "open" ? "text-error" : "text-ink-muted")}>{channel.dmPolicy}</strong>
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-3 ml-7 space-y-1.5 text-xs text-ink-muted">
          <div>
            <strong>DM policy:</strong> {channel.dmPolicy}
            {channel.dmPolicy === "open" && <span className="text-error ml-1">— anyone can message the agent</span>}
            {channel.dmPolicy === "allowlist" && channel.allowedUsers != null && <span> ({channel.allowedUsers} allowed user{channel.allowedUsers !== 1 ? "s" : ""})</span>}
            {channel.dmPolicy === "pairing" && <span className="text-warning ml-1">— requires approval, but anyone can request</span>}
          </div>
          <div><strong>Group policy:</strong> {channel.groupPolicy}</div>
          {channel.boundAgents.length > 0 && (
            <div><strong>Bound agents:</strong> {channel.boundAgents.join(", ")}</div>
          )}
          {channel.boundAgents.length === 0 && (
            <div><strong>Bound agents:</strong> none (uses default agent)</div>
          )}
        </div>
      )}
    </div>
  );
}

function WebhookRow({ webhook }: { webhook: AccessWebhook }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className="text-sm font-mono text-ink-muted">{webhook.path}</span>
      <span className="text-xs text-ink-faint">{webhook.name}</span>
      {webhook.transform && <span className="text-xs font-mono text-ink-faint">{webhook.transform}</span>}
      <span className="ml-auto">
        {webhook.hasToken
          ? <span className="text-xs text-healthy">token-protected</span>
          : <span className="text-xs text-error">no auth</span>}
      </span>
    </div>
  );
}

// =============================================================================
// Section 2: Activity
// =============================================================================

function ActivitySection({ channels, surface }: { channels: ChannelActivity[]; surface: import("@/lib/api").AccessSurface }) {
  if (channels.length === 0) return null;

  // Build a risk lookup from access surface
  const riskMap = new Map(surface.channels.map((c) => [c.name, c.risk]));

  return (
    <section>
      <SectionHeader icon={<Activity className="w-4 h-4" />} title="Activity" subtitle="What's flowing through those doors?" />

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="grid grid-cols-[1fr_70px_70px_70px_70px_100px] gap-2 px-4 py-2 border-b border-border text-[10px] uppercase tracking-wider text-ink-faint">
          <span>Channel</span>
          <span className="text-right">Sessions</span>
          <span className="text-right">Messages</span>
          <span className="text-right">Tools</span>
          <span className="text-right">Agents</span>
          <span className="text-right">Last active</span>
        </div>

        {channels.map((ch) => {
          const risk = riskMap.get(ch.channel);
          const isHighRiskActive = risk === "high" && ch.sessions24h > 0;
          const inactive = ch.sessions7d === 0;

          return (
            <ActivityRow key={ch.channel} channel={ch} highlighted={isHighRiskActive} dimmed={inactive} />
          );
        })}
      </div>

      <p className="text-[11px] text-ink-faint mt-2">Showing last 24 hours. Parentheses show 7-day totals.</p>
    </section>
  );
}

function ActivityRow({ channel, highlighted, dimmed }: { channel: ChannelActivity; highlighted: boolean; dimmed: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "grid grid-cols-[1fr_70px_70px_70px_70px_100px] gap-2 px-4 py-2.5 w-full text-left border-b border-border/40 last:border-b-0 transition-colors hover:bg-cream-dark/30",
          highlighted && "bg-error/5",
          dimmed && "opacity-40",
        )}
      >
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink capitalize">{channel.channel}</span>
          {highlighted && <span className="text-[10px] text-error font-medium">open + active</span>}
        </span>
        <span className="text-xs text-ink-muted text-right tabular-nums">
          {channel.sessions24h} <span className="text-ink-faint">({channel.sessions7d})</span>
        </span>
        <span className="text-xs text-ink-muted text-right tabular-nums">
          {formatNumber(channel.messages24h)} <span className="text-ink-faint">({formatNumber(channel.messages7d)})</span>
        </span>
        <span className="text-xs text-ink-muted text-right tabular-nums">
          {formatNumber(channel.toolCalls24h)} <span className="text-ink-faint">({formatNumber(channel.toolCalls7d)})</span>
        </span>
        <span className="text-xs text-ink-muted text-right tabular-nums">
          {channel.uniqueSenders24h}
        </span>
        <span className="text-xs text-ink-faint text-right">
          {channel.lastActivity ? formatRelativeTime(channel.lastActivity) : "never"}
        </span>
      </button>
      {expanded && channel.topTools.length > 0 && (
        <div className="px-4 pb-2 border-b border-border/40 text-xs text-ink-faint">
          Top tools: {channel.topTools.join(", ")}
        </div>
      )}
    </>
  );
}

// =============================================================================
// Section 3: Config Health
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
      <SectionHeader icon={<Server className="w-4 h-4" />} title="Config Health" subtitle="Is the system configured safely?" />

      <div className="bg-card rounded-xl border border-border">
        {/* Summary bar */}
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

        {/* Expanded checklist */}
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
// Shared
// =============================================================================

function SectionHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-ink-faint">{icon}</span>
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <span className="text-xs text-ink-faint">— {subtitle}</span>
    </div>
  );
}
