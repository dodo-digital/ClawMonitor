import { useHealth } from "@/lib/api";
import { StatusDot } from "@/components/ui/badge";
import { formatUptime } from "@/lib/utils";
import { Server } from "lucide-react";

export function Topbar() {
  const { data: health } = useHealth();
  const isHealthy = !!health;

  return (
    <header className="h-11 border-b border-border/60 bg-cream flex items-center justify-between px-5 sticky top-0 z-10">
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <Server className="w-3.5 h-3.5" />
        <span className="font-medium text-ink">ubuntu-4gb-ash-1</span>
      </div>

      <div className="flex items-center gap-4">
        {health && (
          <span className="text-[11px] text-ink-faint font-mono">
            {formatUptime(health.uptimeSeconds)}
          </span>
        )}
        <div className="flex items-center gap-1.5 text-xs">
          <StatusDot status={isHealthy ? "healthy" : "error"} />
          <span className={isHealthy ? "text-healthy" : "text-error"}>
            {isHealthy ? "Online" : "Connecting..."}
          </span>
        </div>
      </div>
    </header>
  );
}
