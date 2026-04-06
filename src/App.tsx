import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router";
import { CommandChat } from "@/components/CommandChat";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { Dashboard } from "@/pages/Dashboard";
import { Activity } from "@/pages/Activity";
import { Sessions } from "@/pages/Sessions";
import { SessionRuns } from "@/pages/SessionRuns";
import { SessionDetail } from "@/pages/SessionDetail";
import { LiveFeed } from "@/pages/LiveFeed";
import { CronJobs } from "@/pages/CronJobs";
import { Identity } from "@/pages/Identity";
import { Memory } from "@/pages/Memory";
import { Agents } from "@/pages/Agents";
import { AgentProfile } from "@/pages/AgentProfile";
import { Incidents } from "@/pages/Incidents";
import { Security } from "@/pages/Security";
import { IncidentDetail } from "@/pages/IncidentDetail";
import { Skills } from "@/pages/Skills";
import { Plugins } from "@/pages/Plugins";
import { useAgents } from "@/lib/api";
import { setTopicLabels } from "@/lib/utils";

export function App() {
  const { data: agents } = useAgents();

  useEffect(() => {
    if (agents) setTopicLabels(agents);
  }, [agents]);

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <CommandChat />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar />
        <main className="flex-1 p-5">
          <Routes>
            {/* Instance-level pages */}
            <Route index element={<Dashboard />} />

            <Route path="activity" element={<Activity />}>
              <Route index element={<Sessions />} />
              <Route path="live" element={<LiveFeed />} />
            </Route>

            <Route path="activity/:agentId/:sessionId" element={<SessionRuns />} />
            <Route path="activity/:agentId/:sessionId/:runId" element={<SessionDetail />} />

            <Route path="incidents" element={<Incidents />} />
            <Route path="incidents/:incidentId" element={<IncidentDetail />} />
            <Route path="security" element={<Security />} />

            {/* Agent list page */}
            <Route path="agents" element={<Agents />} />

            {/* Agent-scoped pages */}
            <Route path="agents/:agentId" element={<AgentProfile />} />
            <Route path="agents/:agentId/cron" element={<CronJobs />} />
            <Route path="agents/:agentId/skills" element={<Skills />} />
            <Route path="agents/:agentId/knowledge" element={<Memory />} />
            <Route path="agents/:agentId/identity" element={<Identity />} />

            {/* Global Skills (instance-wide view) */}
            <Route path="skills" element={<Skills />} />

            {/* Legacy top-level routes → redirect to default agent */}
            <Route path="cron" element={<Navigate to="/agents/direct/cron" replace />} />
            <Route path="memory" element={<Navigate to="/agents/direct/knowledge" replace />} />
            <Route path="identity" element={<Navigate to="/agents/direct/identity" replace />} />
            <Route path="plugins" element={<Plugins />} />

            {/* Legacy session redirects */}
            <Route path="sessions" element={<Navigate to="/activity" replace />} />
            <Route path="sessions/:agentId/:sessionId" element={<RedirectSession />} />
            <Route path="sessions/:agentId/:sessionId/:runId" element={<RedirectSession />} />
            <Route path="live" element={<Navigate to="/activity/live" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/** Redirect old /sessions/:agentId/:sessionId[/:runId] → /activity/... */
function RedirectSession() {
  const path = window.location.pathname.replace(/^\/sessions\//, "/activity/");
  return <Navigate to={path} replace />;
}
