import useSWR, { type SWRConfiguration } from "swr";

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (json.ok === false) {
    throw new Error(json.error ?? "Unknown API error");
  }
  return json.data;
}

export function useApi<T>(path: string | null, config?: SWRConfiguration) {
  return useSWR<T>(path, fetcher, config);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(json.error ?? `API error: ${res.status}`);
  }
  return json.data;
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(json.error ?? `API error: ${res.status}`);
  }
  return json.data;
}

// Typed API hooks

export type SystemHealth = {
  cpu: { load1: number; load5: number; load15: number; cores: number };
  memory: { totalKb: number; availableKb: number; usedKb: number; usedPercent: number };
  disk: { filesystem: string; sizeKb: number; usedKb: number; availableKb: number; usePercent: number; mount: string };
  uptimeSeconds: number;
};

export type AnalyticsSummary = {
  last24h: {
    runs_24h: number;
    messages_24h: number;
    active_sessions_24h: number;
    tool_calls_24h: number;
    skill_triggers_24h: number;
  };
  byChannel: Array<{ channel: string; source: string; runs: number }>;
  byAgent: Array<{ agent_id: string; runs: number }>;
  recentRuns: Array<{
    run_id: string;
    session_key: string;
    agent_id: string;
    channel: string;
    channel_name: string;
    source: string;
    started_at: string;
    ended_at: string | null;
    duration_ms: number | null;
    first_user_message: string | null;
  }>;
  totalSessions: number;
  totalMessages: number;
  totalEvents: number;
};

export type CostsSummary = {
  summary: {
    total_cost: number;
    cost_24h: number;
    cost_7d: number;
    assistant_messages: number;
    priced_messages: number;
  };
  byAgent: Array<{ agent_id: string; total_cost: number; assistant_messages: number }>;
  byDay: Array<{ day: string; total_cost: number; assistant_messages: number }>;
};

export type Session = {
  sessionId: string;
  agentId: string;
  sessionKey: string;
  channel: string;
  displayName: string;
  category: "conversation" | "cron" | "system";
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalCost: number;
  toolCallCount: number;
  lastUserMessage: string | null;
  durationMs: number | null;
  runCount: number;
};

export type ToolCall = {
  type: string;
  id: string;
  name: string;
  arguments: Record<string, unknown> | null;
  partialJson: string | null;
};

export type SessionMessage = {
  type: string;
  role: string;
  content: string | null;
  timestamp: string;
  toolCalls: ToolCall[];
  tokenUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: { total?: number };
  } | null;
};

export type SessionDetail = {
  items: SessionMessage[];
  offset: number;
  limit: number;
  hasMore: boolean;
};

export type CronJob = {
  id: string;
  name: string;
  agentId: string;
  enabled: boolean;
  schedule: { kind: string; expr?: string; at?: string; tz?: string };
  sessionTarget: string;
  deliveryMode: string;
  state: { lastRunAtMs: number; lastStatus: string; lastDurationMs: number } | null;
};

export type SystemCronEntry = {
  schedule: string;
  command: string;
  logFile: string | null;
};

export type BootstrapFile = {
  name: string;
  sizeChars: number;
  budgetMax: number;
  injectionOrder: number;
  loadInSubagent: boolean;
  specialInstruction: string | null;
};

export type BootstrapData = {
  files: BootstrapFile[];
  totalBudget: { used: number; max: number };
};

export type QmdCollection = {
  name: string;
  pattern: string;
  fileCount: number;
  updated: string;
};

export type QmdStatus = {
  raw: string;
  collections: QmdCollection[];
};

export type MemoryFile = {
  name: string;
  size: number;
  modifiedAt: string;
  preview: string;
};

export type Agent = {
  id: string;
  displayName: string;
  workspace: string;
  model: string | { primary: string; fallbacks: string[] };
  runtimeType: string;
  telegramBinding: Record<string, unknown> | null;
  sessionCount: number;
  identityFiles: Array<{ name: string; exists: boolean }>;
  cronJobCount: number;
};

export function useHealth() {
  return useApi<SystemHealth>("/api/system/health", { refreshInterval: 30_000 });
}

/** Build a URL with optional agent query param. agentParam is "agent=xxx" or "" */
function withAgent(base: string, agentParam: string): string {
  if (!agentParam) return base;
  return base.includes("?") ? `${base}&${agentParam}` : `${base}?${agentParam}`;
}

export function useSummary(agentParam = "") {
  return useApi<AnalyticsSummary>(withAgent("/api/analytics/summary", agentParam), { refreshInterval: 60_000 });
}

export function useCosts(agentParam = "") {
  return useApi<CostsSummary>(withAgent("/api/analytics/costs", agentParam), { refreshInterval: 60_000 });
}

export function useSessions(agentParam = "") {
  return useApi<{ items: Session[] }>(withAgent("/api/sessions", agentParam), { refreshInterval: 60_000 });
}

export type RunSummary = {
  run_id: string;
  session_key: string;
  agent_id: string;
  channel: string;
  model: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  status: string;
  total_cost: number;
  message_count: number;
  tool_call_count: number;
  first_user_message: string | null;
};

export function useSessionRuns(agentId: string, sessionId: string) {
  return useApi<{ runs: RunSummary[] }>(
    `/api/sessions/${agentId}/${sessionId}/runs`,
    { refreshInterval: 0 },
  );
}

export function useSessionDetail(agentId: string, sessionId: string) {
  return useApi<SessionDetail>(
    `/api/sessions/${agentId}/${sessionId}?messagesOnly=true`,
    { refreshInterval: 0 },
  );
}

export function useCronInternal() {
  return useApi<CronJob[]>("/api/cron/internal", { refreshInterval: 60_000 });
}

export function useCronSystem() {
  return useApi<SystemCronEntry[]>("/api/cron/system", { refreshInterval: 60_000 });
}

// --- Unified Cron Registry types ---

export type RegistryExpects = {
  exit_code?: number;
  log_contains?: string;
  log_not_contains?: string;
};

export type RegistryHealth = {
  status: "healthy" | "failing" | "disabled" | "unknown";
  details: string;
};

export type RunStats = {
  total: number;
  ok: number;
  errors: number;
  successRate: number; // 0-100, or -1 if no runs
  lastRunAt: number | null;
  lastStatus: string | null;
  lastDurationMs: number | null;
};

export type RegistryJob = {
  id: string;
  name: string;
  schedule: string;
  layer: "linux" | "openclaw";
  enabled: boolean;
  category: string;
  command: string;
  log?: string;
  openclaw_id?: string;
  description: string;
  expects?: RegistryExpects;
  needs_ai: boolean;
  health: RegistryHealth | null;
  stats: RunStats;
  agentId?: string | null;
};

export type RegistryData = {
  jobs: RegistryJob[];
  archived?: RegistryJob[];
};

export type RunEntry = {
  ts: number;
  jobId: string;
  action: string;
  status: string;
  summary?: string;
  runAtMs?: number;
  durationMs?: number;
  sessionKey?: string;
  sessionId?: string;
};

export type SessionTraceMessage = {
  role: string;
  content: string;
  tokens: number;
  cost_total: number;
  timestamp: string;
};

export type SessionTraceToolCall = {
  tool_name: string;
  input: string;
  output: string;
  duration_ms: number;
  success: number;
  timestamp: string;
};

export type SessionTrace = {
  session_key: string;
  messages: SessionTraceMessage[];
  tool_calls: SessionTraceToolCall[];
};

export type CronSession = {
  run_id: string;
  session_key: string;
  agent_id: string;
  model: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  status: string;
};

export type JobSessionData = {
  id: string;
  sessions: CronSession[];
  trace: SessionTrace | null;
};

export function useCronRegistry(params?: { layer?: string; category?: string; status?: string }) {
  const search = new URLSearchParams();
  if (params?.layer) search.set("layer", params.layer);
  if (params?.category) search.set("category", params.category);
  if (params?.status) search.set("status", params.status);
  const qs = search.toString();
  return useApi<RegistryData>(`/api/cron/registry${qs ? `?${qs}` : ""}`, { refreshInterval: 60_000 });
}

export function useCronJob(id: string | null) {
  return useApi<RegistryJob & { health: RegistryHealth; runs: RunEntry[] }>(
    id ? `/api/cron/registry/${id}` : null,
    { refreshInterval: 0 },
  );
}

export function useCronJobSession(id: string | null) {
  return useApi<JobSessionData>(
    id ? `/api/cron/registry/${id}/session` : null,
    { refreshInterval: 0 },
  );
}

export type CronJobConfig = {
  id: string;
  openclawId: string;
  agentId: string | null;
  sessionTarget: string | null;
  wakeMode: string | null;
  prompt: string | null;
  payloadKind: string | null;
  thinking: string | null;
  timeoutSeconds: number | null;
  delivery: { mode?: string; channel?: string } | null;
};

export function useCronJobConfig(id: string | null) {
  return useApi<CronJobConfig>(
    id ? `/api/cron/registry/${id}/config` : null,
    { refreshInterval: 0 },
  );
}

export type TranscriptItem = {
  role: string;
  content: string | null;
  toolCalls: Array<{ type: string; name: string; arguments: unknown; id?: string }>;
  thinkingBlocks: string[];
  tokenUsage: unknown;
  timestamp: string | null;
  // Metadata entries
  sessionId?: string;
  cwd?: string;
  provider?: string;
  modelId?: string;
};

export function useCronRunTranscript(jobId: string | null, sessionId: string | null) {
  return useApi<{ jobId: string; sessionId: string; items: TranscriptItem[] }>(
    jobId && sessionId ? `/api/cron/registry/${jobId}/runs/${sessionId}/transcript` : null,
    { refreshInterval: 0 },
  );
}

export async function updateCronJobConfig(id: string, update: { prompt?: string; timeoutSeconds?: number; delivery?: { mode?: string } }) {
  return apiPut<{ updated: boolean }>(`/api/cron/registry/${id}/config`, update);
}

export function useBootstrapFiles(agentParam = "") {
  return useApi<BootstrapData>(
    withAgent("/api/bootstrap/files", agentParam),
    { refreshInterval: 0 },
  );
}

export function useQmdStatus() {
  return useApi<QmdStatus>("/api/memory/qmd/status", { refreshInterval: 0 });
}

export function useMemoryFiles() {
  return useApi<MemoryFile[]>("/api/memory/files", { refreshInterval: 0 });
}

export function useAgents() {
  return useApi<Agent[]>("/api/agents", { refreshInterval: 60_000 });
}

// --- Knowledge / Memory types ---

export type FactDecay = "hot" | "warm" | "cold";

export type FactWithDecay = {
  id: string;
  fact: string;
  category: string;
  timestamp: string;
  source: string;
  status: string;
  supersededBy: string | null;
  lastAccessed: string;
  accessCount: number;
  priority: string;
  daysSinceAccess: number;
  decay: FactDecay;
};

export type EntityDetail = {
  id: string;
  entity: string;
  facts: FactWithDecay[];
  totalFacts: number;
  activeFacts: number;
  supersededFacts: number;
};

export type ActivityFact = {
  factId: string;
  fact: string;
  category: string;
  timestamp: string;
  source: string;
  status: string;
  priority: string;
  entity: string;
  entityPath: string;
};

export type RecentNote = {
  name: string;
  modifiedAt: string;
  size: number;
};

export type ActivityFeed = {
  facts: ActivityFact[];
  totalFacts: number;
  recentNotes: RecentNote[];
};

export type LifeTreeNode = {
  name: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: string;
  children?: LifeTreeNode[];
};

export type DataSource = {
  id: string;
  name: string;
  description: string;
  type: string;
  path: string;
  native: boolean;
  renderer: string;
  entityCount: number;
};

export function useLifeTree() {
  return useApi<LifeTreeNode[]>("/api/memory/life", { refreshInterval: 0 });
}

export function useEntityDetail(entityPath: string | null) {
  return useApi<EntityDetail>(
    entityPath ? `/api/memory/entity?path=${encodeURIComponent(entityPath)}` : null,
    { refreshInterval: 0 },
  );
}

export function useActivityFeed(limit = 50) {
  return useApi<ActivityFeed>(`/api/memory/activity?limit=${limit}`, { refreshInterval: 60_000 });
}

export function useDataSources() {
  return useApi<DataSource[]>("/api/memory/sources", { refreshInterval: 0 });
}

// --- Agent Context ---

export type AgentContextFile = {
  path: string;
  relativePath: string;
  category: string;
  exists: boolean;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: string;
  preview?: string;
};

export type AgentContextOrphan = {
  path: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
};

export type AgentContextData = {
  registered: AgentContextFile[];
  orphans: AgentContextOrphan[];
  stats: {
    totalRegistered: number;
    totalExisting: number;
    totalMissing: number;
    totalOrphans: number;
    totalDirectories: number;
  };
};

export type AgentContextFileContent = {
  path: string;
  name: string;
  content: string;
  size: number;
  modifiedAt: string;
};

export function useAgentContext(agentParam = "") {
  return useApi<AgentContextData>(withAgent("/api/memory/agent-context", agentParam), { refreshInterval: 60_000 });
}

// --- Security ---

export type SecurityCategoryScore = {
  score: number;
  max: number;
  details: string[];
};

export type SecurityCredentialCategory = SecurityCategoryScore & {
  findings: Array<{ pattern: string; label: string; index: number; snippet: string }>;
};

export type SecuritySkillDriftCategory = SecurityCategoryScore & {
  added: string[];
  removed: string[];
  modified: string[];
  baselineCount: number;
  currentCount: number;
};

export type SecurityComplianceReport = {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  breakdown: {
    execPosture: SecurityCategoryScore;
    credentialExposure: SecurityCredentialCategory;
    skillIntegrity: SecuritySkillDriftCategory;
    authHealth: SecurityCategoryScore;
  };
  scannedAt: string;
};

export type SecurityHistoryItem = {
  id: number;
  score: number;
  scanned_at: string;
};

export function useSecurityLatest() {
  return useApi<SecurityComplianceReport | null>("/api/security/latest", { refreshInterval: 60_000 });
}

export function useSecurityHistory() {
  return useApi<{ items: SecurityHistoryItem[] }>("/api/security/history", { refreshInterval: 60_000 });
}

// --- Access Surface ---

export type AccessChannel = {
  name: string;
  enabled: boolean;
  dmPolicy: string;
  groupPolicy: string;
  allowedUsers: number | null;
  boundAgents: string[];
  risk: "low" | "medium" | "high";
  explanation: string;
};

export type AccessWebhook = {
  path: string;
  name: string;
  transform: string | null;
  hasToken: boolean;
};

export type AccessSurface = {
  channels: AccessChannel[];
  webhooks: AccessWebhook[];
  hooksEnabled: boolean;
  gateway: {
    bind: string;
    authMode: string;
    tailscale: boolean;
    trustedProxies: number;
  };
  execSecurity: string;
  agentCount: number;
  totalBindings: number;
};

export type ChannelActivity = {
  channel: string;
  sessions24h: number;
  messages24h: number;
  toolCalls24h: number;
  sessions7d: number;
  messages7d: number;
  toolCalls7d: number;
  lastActivity: string | null;
  uniqueSenders24h: number;
  topTools: string[];
};

export function useAccessSurface() {
  return useApi<AccessSurface>("/api/security/access-surface", { refreshInterval: 60_000 });
}

export function useChannelActivity() {
  return useApi<{ byChannel: ChannelActivity[] }>("/api/security/activity", { refreshInterval: 30_000 });
}

// --- Heal ---

export type HealResult = {
  success: boolean;
  fixed: string[];
  broken: string[];
  manual: string[];
  fixedCount: number;
  brokenCount: number;
  manualCount: number;
};

export type TriageResult = {
  version: string;
  previousVersion: string;
  issues: string[];
  fixes: string[];
  issueCount: number;
  fixCount: number;
  healthy: boolean;
};

export type IncidentStatus = "open" | "acknowledged" | "resolved";
export type IncidentSeverity = "info" | "warning" | "critical";

export type IncidentListItem = {
  id: number;
  workspace_id: string;
  dedupe_key: string;
  check_type: string;
  target_key: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  title: string;
  summary: string;
  opened_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  last_seen_at: string;
  acknowledged_by_user_id: string | null;
  resolution_note: string | null;
  event_count: number;
};

export type IncidentEvent = {
  id: number;
  incident_id: number;
  event_type: string;
  payload_json: string;
  created_at: string;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
};

export type IncidentResult = {
  id: number;
  workspace_id: string;
  check_type: string;
  target_key: string;
  status: string;
  severity: IncidentSeverity;
  summary: string;
  evidence_json: string;
  dedupe_key: string;
  observed_at: string;
  evidence: Record<string, unknown>;
};

export type IncidentDetailData = {
  incident: Omit<IncidentListItem, "event_count">;
  events: IncidentEvent[];
  recentResults: IncidentResult[];
};

export function useIncidents() {
  return useApi<{ items: IncidentListItem[] }>("/api/monitor/incidents", { refreshInterval: 30_000 });
}

export function useIncidentDetail(id: string | null) {
  return useApi<IncidentDetailData>(
    id ? `/api/monitor/incidents/${id}` : null,
    { refreshInterval: 30_000 },
  );
}

// --- Exec Security ---

export type ExecSecuritySettings = {
  gatewayExecSecurity: string | null;
  gatewayExecAsk: string | null;
  gatewayStrictInlineEval: boolean | null;
  approvalsDefaultSecurity: string | null;
  approvalsDefaultAsk: string | null;
  approvalsDefaultAskFallback: string | null;
  approvalsHasWildcard: boolean;
};

export type ExecSecurityStatus = {
  settings: ExecSecuritySettings;
  cronReady: boolean;
  cronBlockers: string[];
};

export function useExecSecurity() {
  return useApi<ExecSecurityStatus>("/api/system/exec-security", { refreshInterval: 5 * 60_000 });
}

export type PendingApproval = {
  id: string;
  command: string;
  args: string[];
  cwd: string | null;
  agentId: string | null;
  resolvedPath: string | null;
  receivedAt: number;
  timeoutMs: number | null;
};

export function usePendingApprovals() {
  return useApi<{ approvals: PendingApproval[] }>("/api/system/exec-approvals/pending", { refreshInterval: 2_000 });
}

// --- Skills ---

export type SkillInfo = {
  name: string;
  description: string;
  version: string | null;
  source: string;
  filePath: string;
  triggerCount: number;
  lastTriggered: string | null;
  uniqueSessions: number;
  uniqueChannels: number;
  channels: string[];
};

export type SkillTrigger = {
  id: number;
  skill_name: string;
  agent_id: string;
  session_key: string;
  channel: string;
  channel_name: string | null;
  source: string;
  timestamp: string;
};

export function useSkills(days = 30) {
  return useApi<{ skills: SkillInfo[]; days: number }>(`/api/skills/list?days=${days}`, { refreshInterval: 60_000 });
}

export function useSkillTriggers(name: string | null, days = 30) {
  return useApi<{ triggers: SkillTrigger[]; total: number; days: number }>(
    name ? `/api/skills/${encodeURIComponent(name)}/triggers?days=${days}` : null,
    { refreshInterval: 0 },
  );
}

export function useSkillContent(name: string | null) {
  return useApi<{ name: string; content: string; filePath: string }>(
    name ? `/api/skills/${encodeURIComponent(name)}/content` : null,
    { refreshInterval: 0 },
  );
}

// Plugins

export type Plugin = {
  id: string;
  name: string;
  description: string;
  version: string | null;
  origin: "bundled" | "global" | "custom";
  enabled: boolean;
  status: string;
  category: string;
  capabilities: string[];
};

export type PluginsData = {
  total: number;
  enabled: number;
  disabled: number;
  plugins: Plugin[];
};

export function usePlugins() {
  return useApi<PluginsData>("/api/plugins", { refreshInterval: 60_000 });
}

// --- Setup / Onboarding ---

export type SetupChecklist = {
  agentConnected: boolean;
  skillInstalled: boolean;
  watchdogRunning: boolean;
  securityScanRun: boolean;
  notificationsConfigured: boolean;
  telegramBound: boolean;
};

export type SetupPreflight = {
  openclawInstalled: boolean;
  openclawHome: boolean;
  configExists: boolean;
  gatewayReachable: boolean;
  issues: string[];
};

export type SetupStatus = {
  configured: boolean;
  agentId: string | null;
  backend: string | null;
  agentLive: boolean;
  needsGatewayRestart: boolean;
  detectedBackends: string[];
  checklist: SetupChecklist;
  preflight?: SetupPreflight;
  issues: string[];
};

export type ProvisionResult = {
  success: boolean;
  completed: string[];
  failed: Array<{ step: string; error: string }>;
  note: string;
};

export type TestAgentResult = {
  success: boolean;
  response: string;
  latencyMs: number;
};

export function useSetupStatus() {
  return useApi<SetupStatus>("/api/setup/status", { refreshInterval: 30_000 });
}
