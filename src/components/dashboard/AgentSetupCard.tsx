import { useState } from "react";
import {
  useSetupStatus,
  apiPost,
  type ProvisionResult,
  type TestAgentResult,
  type SetupChecklist,
} from "@/lib/api";
import {
  Check,
  Circle,
  X,
  Loader2,
  Zap,
  Copy,
  RefreshCw,
  MessageSquare,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// Pre-filled prompts for checklist items that need user input
const SETUP_PROMPTS: Record<string, string> = {
  notificationsConfigured:
    "Help me set up notifications for ClawMonitor. I want to get alerted when something breaks. What channels do you support?",
  telegramBound:
    "Bind ClawMonitor to a Telegram topic so I can interact with the agent from Telegram",
};

// Fix commands for common failures
const FIX_COMMANDS: Record<string, string> = {
  "agent config": "openclaw agent add --id acp-clawmonitor --model claude --workspace default",
  "skill symlink": "ln -s $(pwd)/skills/openclaw-ops ~/.openclaw/skills/openclaw-ops",
  "watchdog cron":
    'cron-cli add --id gateway-watchdog --name "Gateway Watchdog" --schedule "*/5 * * * *" --command "bash server/scripts/watchdog.sh" --category system',
  "security scan": "curl -X POST http://localhost:18801/api/security/scan",
};

type CardState =
  | "not-installed"
  | "welcome"
  | "provisioning"
  | "restart-gateway"
  | "checklist"
  | "connected";

function getCardState(
  status:
    | {
        configured: boolean;
        needsGatewayRestart: boolean;
        agentLive: boolean;
        checklist: SetupChecklist;
        preflight?: { configExists: boolean };
      }
    | undefined,
  provisioning: boolean,
  justProvisioned: boolean,
): CardState {
  if (provisioning) return "provisioning";
  if (!status) return "welcome";
  if (status.preflight && !status.preflight.configExists) return "not-installed";
  if (!status.configured) return "welcome";

  // Agent is in config but gateway hasn't loaded it
  if (status.needsGatewayRestart || (justProvisioned && !status.agentLive)) {
    return "restart-gateway";
  }

  const cl = status.checklist;
  const allDone =
    cl.agentConnected &&
    cl.skillInstalled &&
    cl.watchdogRunning &&
    cl.securityScanRun &&
    cl.notificationsConfigured &&
    cl.telegramBound;

  if (allDone && status.agentLive) return "connected";
  return "checklist";
}

const CHECKLIST_LABELS: Record<keyof SetupChecklist, string> = {
  agentConnected: "Agent connected",
  skillInstalled: "Ops skill installed",
  watchdogRunning: "Watchdog cron running",
  securityScanRun: "Security scan run",
  notificationsConfigured: "Notifications",
  telegramBound: "Telegram",
};

const CHECKLIST_DESCRIPTIONS: Record<keyof SetupChecklist, string> = {
  agentConnected: "ACP agent registered in openclaw.json",
  skillInstalled: "openclaw-ops skill linked for operational runbooks",
  watchdogRunning: "5-minute health check and auto-restart",
  securityScanRun: "Initial security compliance baseline",
  notificationsConfigured: "Get alerted when things break",
  telegramBound: "Interact with the agent from Telegram",
};

export function AgentSetupCard({
  onOpenChat,
}: {
  onOpenChat?: (prefill?: string) => void;
}) {
  const { data: status, mutate } = useSetupStatus();
  const [provisioning, setProvisioning] = useState(false);
  const [justProvisioned, setJustProvisioned] = useState(false);
  const [provisionResult, setProvisionResult] = useState<ProvisionResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestAgentResult | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [copiedStep, setCopiedStep] = useState<string | null>(null);
  const [copiedRestart, setCopiedRestart] = useState(false);

  const cardState = getCardState(status, provisioning, justProvisioned);

  async function handleProvision() {
    setProvisioning(true);
    setProvisionResult(null);
    setTestResult(null);
    try {
      const result = await apiPost<ProvisionResult>("/api/setup/provision");
      setProvisionResult(result);
      setJustProvisioned(true);
      await mutate();
    } catch {
      setProvisionResult({
        success: false,
        completed: [],
        failed: [{ step: "provision", error: "Failed to reach setup endpoint" }],
        note: "Could not connect to the server.",
      });
    } finally {
      setProvisioning(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiPost<TestAgentResult>("/api/setup/test");
      setTestResult(result);
      if (result.success) {
        // Agent is live — clear the justProvisioned flag so we move past restart state
        setJustProvisioned(false);
        await mutate();
      }
    } catch {
      setTestResult({ success: false, response: "Request failed", latencyMs: 0 });
    } finally {
      setTesting(false);
    }
  }

  async function handleCheckGateway() {
    // Re-check status to see if gateway has picked up the agent
    const fresh = await mutate();
    if (fresh?.agentLive) {
      setJustProvisioned(false);
    }
  }

  function copyCommand(step: string) {
    const cmd = FIX_COMMANDS[step];
    if (cmd) {
      navigator.clipboard.writeText(cmd);
      setCopiedStep(step);
      setTimeout(() => setCopiedStep(null), 2000);
    }
  }

  function copyRestart() {
    navigator.clipboard.writeText("openclaw gateway restart");
    setCopiedRestart(true);
    setTimeout(() => setCopiedRestart(false), 2000);
  }

  // ── Not installed state ──
  if (cardState === "not-installed") {
    const pf = status?.preflight;
    return (
      <div className="border border-error/30 rounded-xl bg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold text-ink">OpenClaw not found</h2>
        <p className="text-xs text-ink-muted leading-relaxed">
          ClawMonitor needs OpenClaw to be installed and initialized before it can
          set up monitoring.
        </p>
        <div className="space-y-1.5 text-xs">
          {pf && !pf.openclawInstalled && (
            <div className="flex items-center gap-2 text-error">
              <X className="w-3 h-3 shrink-0" />
              <span>OpenClaw CLI not in PATH</span>
            </div>
          )}
          {pf && !pf.openclawHome && (
            <div className="flex items-center gap-2 text-error">
              <X className="w-3 h-3 shrink-0" />
              <span>OpenClaw home directory missing</span>
            </div>
          )}
          {pf && !pf.configExists && (
            <div className="flex items-center gap-2 text-error">
              <X className="w-3 h-3 shrink-0" />
              <span>openclaw.json not found</span>
            </div>
          )}
          {pf && !pf.gatewayReachable && (
            <div className="flex items-center gap-2 text-warning">
              <Circle className="w-3 h-3 shrink-0" />
              <span>Gateway not reachable</span>
            </div>
          )}
        </div>
        <div className="bg-cream-dark/50 rounded px-3 py-2 space-y-1">
          <p className="text-[11px] text-ink-muted font-medium">To get started:</p>
          <code className="block text-[11px] font-mono text-ink-muted">npm install -g openclaw</code>
          <code className="block text-[11px] font-mono text-ink-muted">openclaw init</code>
          <code className="block text-[11px] font-mono text-ink-muted">openclaw gateway start</code>
        </div>
      </div>
    );
  }

  // ── Welcome state ──
  if (cardState === "welcome") {
    const gatewayDown = status?.preflight && !status.preflight.gatewayReachable;
    return (
      <div className="border border-border rounded-xl bg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold text-ink">Welcome to ClawMonitor</h2>
        <p className="text-xs text-ink-muted leading-relaxed">
          Let's get your monitoring set up. This takes about a minute &mdash;
          we'll create an agent, install the ops skill, set up the watchdog, and
          run an initial security scan.
        </p>
        {gatewayDown && (
          <div className="flex items-center gap-2 text-xs text-warning">
            <Circle className="w-3 h-3 shrink-0" />
            <span>
              Gateway not reachable &mdash; the agent won't work until it's started.
              Run: <code className="font-mono bg-cream-dark/50 px-1 rounded">openclaw gateway start</code>
            </span>
          </div>
        )}
        <button
          onClick={handleProvision}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors"
        >
          <Zap className="w-4 h-4" />
          Start Setup
        </button>
      </div>
    );
  }

  // ── Provisioning state ──
  if (cardState === "provisioning") {
    return (
      <div className="border border-border rounded-xl bg-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-accent" />
          <span className="text-sm font-medium text-ink">Setting up...</span>
        </div>
        {provisionResult && (
          <div className="space-y-1.5 text-xs">
            {provisionResult.completed.map((step) => (
              <div key={step} className="flex items-center gap-2 text-healthy">
                <Check className="w-3 h-3" />
                <span>{step}</span>
              </div>
            ))}
            {provisionResult.failed.map((f) => (
              <div key={f.step} className="flex items-center gap-2 text-error">
                <X className="w-3 h-3" />
                <span>
                  {f.step}: {f.error}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Restart gateway state ──
  if (cardState === "restart-gateway") {
    return (
      <div className="border border-warning/30 rounded-xl bg-card p-5 space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-ink">Almost there — restart the gateway</h2>
          <p className="text-xs text-ink-muted leading-relaxed">
            The agent is configured but the gateway needs to be restarted to load it.
            Run this in your terminal:
          </p>
        </div>

        <div className="flex items-center gap-2 bg-cream-dark/50 rounded-lg px-3 py-2">
          <code className="text-sm font-mono text-ink flex-1">openclaw gateway restart</code>
          <button
            onClick={copyRestart}
            className="text-ink-faint hover:text-ink transition-colors shrink-0 p-1"
            title="Copy command"
          >
            {copiedRestart ? (
              <Check className="w-3.5 h-3.5 text-healthy" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        {/* What was provisioned */}
        {provisionResult && provisionResult.completed.length > 0 && (
          <div className="space-y-1.5 text-xs">
            <p className="text-[10px] text-ink-faint font-medium uppercase tracking-wider">Completed</p>
            {provisionResult.completed.map((step) => (
              <div key={step} className="flex items-center gap-2 text-healthy">
                <Check className="w-3 h-3" />
                <span>{step}</span>
              </div>
            ))}
            {provisionResult.failed.map((f) => (
              <div key={f.step} className="flex items-center gap-2 text-error">
                <X className="w-3 h-3" />
                <span>{f.step}: {f.error}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1 border-t border-border/40">
          <button
            onClick={handleCheckGateway}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-border text-ink-muted hover:text-ink hover:bg-cream-dark/40 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            Check again
          </button>
          <button
            onClick={handleTest}
            disabled={testing}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-border text-ink-muted hover:text-ink hover:bg-cream-dark/40 transition-colors disabled:opacity-50"
          >
            {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : "Test agent"}
          </button>
          {testResult && (
            <span className={`text-[11px] ${testResult.success ? "text-healthy" : "text-error"}`}>
              {testResult.success ? `OK (${testResult.latencyMs}ms)` : "Not responding yet"}
            </span>
          )}
        </div>
      </div>
    );
  }

  // ── Connected state (compact) ──
  if (cardState === "connected") {
    return (
      <div className="border border-border rounded-xl bg-card px-4 py-2.5 flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <span className="block w-2 h-2 rounded-full bg-healthy" />
          <span className="text-xs font-medium text-ink">Agent connected</span>
        </span>
        {status?.backend && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-cream-dark/60 text-ink-faint">
            {status.backend}
          </span>
        )}
        {status?.checklist.telegramBound && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-cream-dark/60 text-ink-faint">
            telegram
          </span>
        )}
        {status?.checklist.notificationsConfigured && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-cream-dark/60 text-ink-faint">
            notifications
          </span>
        )}
        <button
          onClick={handleTest}
          disabled={testing}
          className="ml-auto text-xs px-2 py-1 rounded border border-border text-ink-muted hover:text-ink hover:bg-cream-dark/40 transition-colors disabled:opacity-50"
        >
          {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : "Test"}
        </button>
        {testResult && (
          <span className={`text-[11px] ${testResult.success ? "text-healthy" : "text-error"}`}>
            {testResult.success ? `OK (${testResult.latencyMs}ms)` : "Failed"}
          </span>
        )}
      </div>
    );
  }

  // ── Checklist state ──
  const cl = status!.checklist;
  const agentLive = status!.agentLive;
  const autoItems: (keyof SetupChecklist)[] = [
    "agentConnected",
    "skillInstalled",
    "watchdogRunning",
    "securityScanRun",
  ];
  const userItems: (keyof SetupChecklist)[] = [
    "notificationsConfigured",
    "telegramBound",
  ];
  const failedSteps = provisionResult?.failed ?? [];
  const failedStepNames = new Set(failedSteps.map((f) => f.step));

  const completedCount = Object.values(cl).filter(Boolean).length;
  const totalCount = Object.keys(cl).length;
  const hasIssues = failedSteps.length > 0;

  return (
    <div className="border border-border rounded-xl bg-card overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-cream-dark/30 transition-colors"
      >
        <span className="block w-2 h-2 rounded-full bg-warning" />
        <span className="text-xs font-medium text-ink">
          {hasIssues
            ? `Setup mostly complete — ${failedSteps.length} issue${failedSteps.length !== 1 ? "s" : ""}`
            : `Getting started (${completedCount}/${totalCount})`}
        </span>
        <span className="ml-auto text-ink-faint">
          {expanded ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-2">
          {/* Auto items */}
          {autoItems.map((key) => {
            const done = cl[key];
            const failed = failedStepNames.has(key);
            const failInfo = failedSteps.find(
              (f) =>
                f.step === key ||
                CHECKLIST_LABELS[key].toLowerCase().includes(f.step.toLowerCase()),
            );

            return (
              <div key={key} className="space-y-1">
                <div className="flex items-center gap-2">
                  {done ? (
                    <Check className="w-3.5 h-3.5 text-healthy shrink-0" />
                  ) : failed ? (
                    <X className="w-3.5 h-3.5 text-error shrink-0" />
                  ) : (
                    <Circle className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                  )}
                  <span className={`text-xs ${done ? "text-ink-muted" : "text-ink"}`}>
                    {CHECKLIST_LABELS[key]}
                  </span>
                  <span className="text-[10px] text-ink-faint">
                    {CHECKLIST_DESCRIPTIONS[key]}
                  </span>
                </div>
                {failInfo && (
                  <div className="ml-5 space-y-1">
                    <p className="text-[11px] text-error">{failInfo.error}</p>
                    {FIX_COMMANDS[failInfo.step] && (
                      <div className="flex items-center gap-1.5 bg-cream-dark/50 rounded px-2 py-1">
                        <code className="text-[10px] text-ink-muted font-mono flex-1 truncate">
                          {FIX_COMMANDS[failInfo.step]}
                        </code>
                        <button
                          onClick={() => copyCommand(failInfo.step)}
                          className="text-ink-faint hover:text-ink transition-colors shrink-0"
                          title="Copy command"
                        >
                          {copiedStep === failInfo.step ? (
                            <Check className="w-3 h-3 text-healthy" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* User items — need agent interaction */}
          {userItems.map((key) => {
            const done = cl[key];
            const prompt = SETUP_PROMPTS[key];

            return (
              <div key={key} className="flex items-center gap-2">
                {done ? (
                  <Check className="w-3.5 h-3.5 text-healthy shrink-0" />
                ) : (
                  <Circle className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                )}
                <span className={`text-xs ${done ? "text-ink-muted" : "text-ink"}`}>
                  {CHECKLIST_LABELS[key]}
                </span>
                <span className="text-[10px] text-ink-faint">
                  {CHECKLIST_DESCRIPTIONS[key]}
                </span>
                {!done && prompt && onOpenChat && agentLive && (
                  <button
                    onClick={() => onOpenChat(prompt)}
                    className="ml-auto flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-border text-ink-muted hover:text-ink hover:bg-cream-dark/40 transition-colors"
                  >
                    <MessageSquare className="w-2.5 h-2.5" />
                    Set up
                  </button>
                )}
              </div>
            );
          })}

          {/* Footer actions */}
          <div className="flex items-center gap-3 pt-2 border-t border-border/40">
            {agentLive ? (
              <>
                <button
                  onClick={handleTest}
                  disabled={testing}
                  className="text-xs px-2.5 py-1 rounded border border-border text-ink-muted hover:text-ink hover:bg-cream-dark/40 transition-colors disabled:opacity-50"
                >
                  {testing ? (
                    <Loader2 className="w-3 h-3 animate-spin inline" />
                  ) : (
                    "Test agent"
                  )}
                </button>
                {testResult && (
                  <span
                    className={`text-[11px] ${testResult.success ? "text-healthy" : "text-error"}`}
                  >
                    {testResult.success
                      ? `OK (${testResult.latencyMs}ms)`
                      : `Failed: ${testResult.response.slice(0, 60)}`}
                  </span>
                )}
                <span className="ml-auto text-[10px] text-ink-faint">
                  Press{" "}
                  <kbd className="px-1 py-0.5 rounded bg-cream-dark/80 font-mono">
                    ⌘K
                  </kbd>{" "}
                  to ask the agent anything
                </span>
              </>
            ) : (
              <span className="text-[11px] text-warning">
                Agent not live on gateway &mdash; restart the gateway to activate it
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
