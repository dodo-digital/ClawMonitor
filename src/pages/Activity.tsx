import { NavLink, Outlet, useLocation } from "react-router";
import { cn } from "@/lib/utils";
import { MessageSquare, Radio } from "lucide-react";

const tabs = [
  { to: "/activity", label: "Sessions", icon: MessageSquare, end: true },
  { to: "/activity/live", label: "Live", icon: Radio, end: false },
];

export function Activity() {
  return (
    <div>
      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-5 border-b border-border/50">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                isActive
                  ? "border-accent text-accent"
                  : "border-transparent text-ink-muted hover:text-ink hover:border-border",
              )
            }
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </NavLink>
        ))}
      </div>

      <Outlet />
    </div>
  );
}
