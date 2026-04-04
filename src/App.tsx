import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router";
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
import { Incidents } from "@/pages/Incidents";
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
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar />
        <main className="flex-1 p-5">
          <Routes>
            <Route index element={<Dashboard />} />

            {/* Activity: Sessions + Live as tabs */}
            <Route path="activity" element={<Activity />}>
              <Route index element={<Sessions />} />
              <Route path="live" element={<LiveFeed />} />
            </Route>

            {/* Session detail routes (nested under activity) */}
            <Route path="activity/:agentId/:sessionId" element={<SessionRuns />} />
            <Route path="activity/:agentId/:sessionId/:runId" element={<SessionDetail />} />

            {/* Redirects for old /sessions and /live routes */}
            <Route path="sessions" element={<Navigate to="/activity" replace />} />
            <Route path="sessions/:agentId/:sessionId" element={<RedirectSession />} />
            <Route path="sessions/:agentId/:sessionId/:runId" element={<RedirectSession />} />
            <Route path="live" element={<Navigate to="/activity/live" replace />} />

            <Route path="cron" element={<CronJobs />} />
            <Route path="skills" element={<Skills />} />
            <Route path="identity" element={<Identity />} />
            <Route path="memory" element={<Memory />} />
            <Route path="agents" element={<Agents />} />
            <Route path="plugins" element={<Plugins />} />
            <Route path="incidents" element={<Incidents />} />
            <Route path="incidents/:incidentId" element={<IncidentDetail />} />
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
