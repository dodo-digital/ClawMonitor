import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { cn } from "@/lib/utils";
import { useAgents } from "@/lib/api";
import {
  LayoutDashboard,
  Activity,
  Siren,
  Shield,
  Clock,
  Sparkles,
  Brain,
  FileText,
  Bot,
  Globe,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
} from "lucide-react";

/** Use the displayName from the API, fall back to title-cased ID */
function getDisplayName(id: string, serverName?: string): string {
  return serverName ?? id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type NavItem = { to: string; icon: typeof LayoutDashboard; label: string; matchPrefix?: string };

const instanceNav: NavItem[] = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/activity", icon: Activity, label: "Activity", matchPrefix: "/activity" },
  { to: "/incidents", icon: Siren, label: "Incidents" },
  { to: "/security", icon: Shield, label: "Security" },
  { to: "/skills", icon: Sparkles, label: "Skills" },
];

const agentSubNav = [
  { suffix: "", icon: Bot, label: "Overview" },
  { suffix: "/cron", icon: Clock, label: "Cron Jobs" },
  { suffix: "/skills", icon: Sparkles, label: "Skills" },
  { suffix: "/knowledge", icon: Brain, label: "Knowledge" },
  { suffix: "/identity", icon: FileText, label: "Identity" },
] as const;

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const { data: agents } = useAgents();

  // Determine which agent is currently active from the URL
  const agentMatch = location.pathname.match(/^\/agents\/([^/]+)/);
  const activeAgentId = agentMatch?.[1] ?? null;

  const navigate = useNavigate();

  // Track which agents are expanded (auto-expand the active one)
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());

  function toggleAgent(id: string) {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // Navigate to agent overview when expanding
        navigate(`/agents/${id}`);
      }
      return next;
    });
  }

  const native = (agents ?? []).filter((a) => a.runtimeType !== "acp");
  const acp = (agents ?? []).filter((a) => a.runtimeType === "acp");

  return (
    <aside
      className={cn(
        "flex flex-col bg-sidebar text-sidebar-text h-screen sticky top-0 transition-all duration-200 border-r border-border/40",
        collapsed ? "w-14" : "w-52",
      )}
    >
      {/* Logo */}
      <div className="flex items-center h-12 px-3 shrink-0">
        <div className="w-6 h-6 rounded-md bg-accent flex items-center justify-center shrink-0">
          <span className="text-white text-[10px] font-bold leading-none">CM</span>
        </div>
        {!collapsed && (
          <span className="ml-2 text-sidebar-text-active font-semibold text-sm tracking-tight">
            ClawMonitor
          </span>
        )}
      </div>

      {/* Scrollable nav area */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-1 px-1.5">
        {/* Instance-level nav */}
        <div className="space-y-px">
          {instanceNav.map((item) => {
            const isActive = item.matchPrefix
              ? location.pathname.startsWith(item.matchPrefix)
              : undefined;

            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={!item.matchPrefix && item.to === "/"}
                className={({ isActive: routerActive }) =>
                  cn(
                    "flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors duration-75",
                    (isActive ?? routerActive)
                      ? "bg-sidebar-active text-sidebar-text-active"
                      : "text-sidebar-text hover:bg-sidebar-hover hover:text-sidebar-text-active",
                    collapsed && "justify-center px-1.5",
                  )
                }
              >
                <item.icon className="w-4 h-4 shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </NavLink>
            );
          })}
        </div>

        {/* Agents section */}
        {(agents ?? []).length > 0 && (
          <>
            <div className={cn("mt-4 mb-1", !collapsed && "px-2.5")}>
              {!collapsed ? (
                <span className="text-[10px] font-semibold text-sidebar-text/40 uppercase tracking-widest">
                  Agents
                </span>
              ) : (
                <div className="border-t border-border/30 my-1" />
              )}
            </div>

            {/* Native agents */}
            {native.map((agent) => {
              const id = agent.id;
              const isExpanded = expandedAgents.has(id) || activeAgentId === id;
              const name = getDisplayName(id, agent.displayName);

              return (
                <AgentNavGroup
                  key={id}
                  agentId={id}
                  name={name}
                  icon={Bot}
                  expanded={isExpanded}
                  collapsed={collapsed}
                  activeAgentId={activeAgentId}
                  pathname={location.pathname}
                  onToggle={() => toggleAgent(id)}
                />
              );
            })}

            {/* ACP agents */}
            {acp.length > 0 && !collapsed && (
              <div className="mt-3 mb-1 px-2.5">
                <span className="text-[10px] font-semibold text-sidebar-text/40 uppercase tracking-widest">
                  ACP
                </span>
              </div>
            )}
            {acp.length > 0 && collapsed && (
              <div className="border-t border-border/30 my-1 mx-1" />
            )}
            {acp.map((agent) => {
              const id = agent.id;
              const isExpanded = expandedAgents.has(id) || activeAgentId === id;
              const name = getDisplayName(id, agent.displayName);

              return (
                <AgentNavGroup
                  key={id}
                  agentId={id}
                  name={name}
                  icon={Globe}
                  expanded={isExpanded}
                  collapsed={collapsed}
                  activeAgentId={activeAgentId}
                  pathname={location.pathname}
                  onToggle={() => toggleAgent(id)}
                />
              );
            })}
          </>
        )}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-center h-9 shrink-0 border-t border-border/30 text-sidebar-text/40 hover:text-sidebar-text-active transition-colors"
      >
        {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
      </button>
    </aside>
  );
}

function AgentNavGroup({
  agentId,
  name,
  icon: Icon,
  expanded,
  collapsed,
  activeAgentId,
  pathname,
  onToggle,
}: {
  agentId: string;
  name: string;
  icon: typeof Bot;
  expanded: boolean;
  collapsed: boolean;
  activeAgentId: string | null;
  pathname: string;
  onToggle: () => void;
}) {
  const basePath = `/agents/${agentId}`;
  const isThisAgent = activeAgentId === agentId;

  if (collapsed) {
    // In collapsed mode, just show the icon linking to the agent overview
    return (
      <NavLink
        to={basePath}
        end
        title={name}
        className={cn(
          "flex items-center justify-center px-1.5 py-1.5 rounded-md transition-colors duration-75 my-px",
          isThisAgent
            ? "bg-sidebar-active text-accent"
            : "text-sidebar-text hover:bg-sidebar-hover hover:text-sidebar-text-active",
        )}
      >
        <Icon className="w-4 h-4" />
      </NavLink>
    );
  }

  return (
    <div className="my-px">
      {/* Agent header — click to expand, icon links to overview */}
      <button
        onClick={onToggle}
        className={cn(
          "flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors duration-75",
          isThisAgent
            ? "text-sidebar-text-active"
            : "text-sidebar-text hover:bg-sidebar-hover hover:text-sidebar-text-active",
        )}
      >
        <Icon className={cn("w-3.5 h-3.5 shrink-0", isThisAgent && "text-accent")} />
        <span className="flex-1 text-left truncate">{name}</span>
        <ChevronDown
          className={cn(
            "w-3 h-3 shrink-0 text-sidebar-text/25 transition-transform duration-100",
            expanded && "rotate-180",
          )}
        />
      </button>

      {/* Sub-navigation */}
      {expanded && (
        <div className="ml-3 pl-2.5 border-l border-border/20 mt-0.5 mb-1 space-y-px">
          {agentSubNav.map((sub) => {
            const to = `${basePath}${sub.suffix}`;
            const isActive = sub.suffix === ""
              ? pathname === basePath
              : pathname.startsWith(to);

            return (
              <NavLink
                key={sub.suffix}
                to={to}
                end={sub.suffix === ""}
                className={cn(
                  "flex items-center gap-2 px-2 py-1 rounded-md text-[12px] font-medium transition-colors duration-75",
                  isActive
                    ? "bg-sidebar-active text-sidebar-text-active"
                    : "text-sidebar-text/70 hover:bg-sidebar-hover hover:text-sidebar-text-active",
                )}
              >
                <sub.icon className="w-3.5 h-3.5 shrink-0" />
                <span>{sub.label}</span>
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}
