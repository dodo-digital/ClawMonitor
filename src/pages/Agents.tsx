import { PageHeader } from "@/components/layout/PageHeader";
import { useAgents, type Agent } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { PageSkeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { formatNumber } from "@/lib/utils";
import { Bot, Folder, Cpu, MessageSquare, Link as LinkIcon, Clock, FileText } from "lucide-react";
import { Link } from "react-router";

export function Agents() {
  const { data, error, mutate } = useAgents();

  if (error) return <ErrorState message="Failed to load agents" onRetry={() => mutate()} />;
  if (!data) return <PageSkeleton />;

  return (
    <div>
      <PageHeader section="07" title="Agents & Config" description={`${data.length} agents configured`} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {data.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </div>
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  const modelName = typeof agent.model === "string" ? agent.model : agent.model.primary;
  const fallbacks = typeof agent.model === "object" ? agent.model.fallbacks : [];
  const identityCount = agent.identityFiles?.filter((f) => f.exists).length ?? 0;

  return (
    <Link to={`/agents/${agent.id}`} className="block bg-card rounded-xl p-6 hover:ring-1 hover:ring-accent/30 transition-all">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
          <Bot className="w-5 h-5 text-accent" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-ink">{agent.displayName ?? agent.id}</h3>
          <div className="flex items-center gap-1.5">
            <Badge variant={agent.runtimeType === "native" ? "accent" : "default"}>
              {agent.runtimeType}
            </Badge>
            <span className="text-[10px] text-ink-faint">{agent.id}</span>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <InfoRow icon={<Folder className="w-3.5 h-3.5" />} label="Workspace" value={agent.workspace} mono />
        <InfoRow icon={<Cpu className="w-3.5 h-3.5" />} label="Model" value={modelName} mono />
        {fallbacks.length > 0 && (
          <div className="ml-6">
            <span className="text-[10px] text-ink-faint uppercase tracking-wider">Fallbacks</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {fallbacks.map((f) => (
                <Badge key={f} variant="muted">{f}</Badge>
              ))}
            </div>
          </div>
        )}
        <InfoRow
          icon={<MessageSquare className="w-3.5 h-3.5" />}
          label="Sessions"
          value={formatNumber(agent.sessionCount)}
        />
        {agent.cronJobCount > 0 && (
          <InfoRow icon={<Clock className="w-3.5 h-3.5" />} label="Cron Jobs" value={String(agent.cronJobCount)} />
        )}
        {identityCount > 0 && (
          <InfoRow icon={<FileText className="w-3.5 h-3.5" />} label="Identity Files" value={`${identityCount} configured`} />
        )}
        {agent.telegramBinding && (
          <InfoRow icon={<LinkIcon className="w-3.5 h-3.5" />} label="Telegram" value="Bound" />
        )}
      </div>
    </Link>
  );
}

function InfoRow({ icon, label, value, mono }: { icon: React.ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-ink-faint mt-0.5">{icon}</span>
      <div className="min-w-0">
        <span className="text-[10px] text-ink-faint uppercase tracking-wider">{label}</span>
        <p className={`text-sm text-ink ${mono ? "font-mono" : ""} truncate`}>{value}</p>
      </div>
    </div>
  );
}
