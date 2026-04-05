import { useState } from "react";
import { NavLink, useLocation } from "react-router";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Activity,
  Siren,
  Clock,
  Sparkles,
  Brain,
  FileText,
  Bot,
  Plug,
  Shield,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

type NavItem = { to: string; icon: typeof LayoutDashboard; label: string; matchPrefix?: string };
type NavSection = { label?: string; items: NavItem[] };

const navSections: NavSection[] = [
  {
    items: [
      { to: "/", icon: LayoutDashboard, label: "Dashboard" },
      { to: "/activity", icon: Activity, label: "Activity", matchPrefix: "/activity" },
      { to: "/incidents", icon: Siren, label: "Incidents" },
      { to: "/security", icon: Shield, label: "Security" },
      { to: "/cron", icon: Clock, label: "Cron Jobs" },
    ],
  },
  {
    label: "Knowledge",
    items: [
      { to: "/skills", icon: Sparkles, label: "Skills" },
      { to: "/memory", icon: Brain, label: "Knowledge Graph" },
    ],
  },
  {
    label: "Setup",
    items: [
      { to: "/identity", icon: FileText, label: "Identity" },
      { to: "/agents", icon: Bot, label: "Agents" },
      { to: "/plugins", icon: Plug, label: "Plugins" },
    ],
  },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();

  return (
    <aside
      className={cn(
        "flex flex-col bg-sidebar text-sidebar-text h-screen sticky top-0 transition-all duration-200 border-r border-border/40",
        collapsed ? "w-14" : "w-52",
      )}
    >
      {/* Logo */}
      <div className="flex items-center h-12 px-3">
        <div className="w-6 h-6 rounded-md bg-accent flex items-center justify-center shrink-0">
          <span className="text-white text-[10px] font-bold leading-none">CM</span>
        </div>
        {!collapsed && (
          <span className="ml-2 text-sidebar-text-active font-semibold text-sm tracking-tight">
            ClawMonitor
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-2 px-1.5">
        {navSections.map((section, si) => (
          <div key={si}>
            {/* Divider + section label */}
            {section.label && (
              <div className={cn("mt-3 mb-1", !collapsed && "px-2.5")}>
                {!collapsed && (
                  <span className="text-[10px] font-semibold text-sidebar-text/40 uppercase tracking-widest">
                    {section.label}
                  </span>
                )}
                {collapsed && (
                  <div className="border-t border-border/30 my-1" />
                )}
              </div>
            )}

            <div className="space-y-px">
              {section.items.map((item) => {
                // For items with matchPrefix, check if current path starts with it
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
                        "flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors duration-100",
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
          </div>
        ))}
      </nav>

      {/* Collapse */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-center h-9 border-t border-border/30 text-sidebar-text/40 hover:text-sidebar-text-active transition-colors"
      >
        {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
      </button>
    </aside>
  );
}
