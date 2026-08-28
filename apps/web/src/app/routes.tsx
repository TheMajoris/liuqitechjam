import { Navigate, Route, Routes } from "react-router-dom";
import type { SystemInfo } from "../api/contracts";
import { AppShell } from "./AppShell";
import { ProjectsPage } from "../features/projects/ProjectsPage";
import { ProjectDetail } from "../features/projects/ProjectDetail";
import { AgentsPage } from "../features/agents/AgentsPage";
import { AgentDetail } from "../features/agents/AgentDetail";
import { ProvidersPage } from "../features/providers/ProvidersPage";
import { OrchestrationsPage } from "../features/orchestrations/OrchestrationsPage";
import { OrchestrationDetail } from "../features/orchestrations/OrchestrationDetail";
import { RunsPage } from "../features/runs/RunsPage";
import { SecurityPage } from "../features/security/SecurityPage";
import { NotFoundPage } from "./NotFoundPage";

export function AppRoutes({ system }: { system: SystemInfo | null }) {
  return (
    <Routes>
      <Route element={<AppShell system={system} />}>
        <Route index element={<Navigate to="/projects" replace />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:projectId" element={<ProjectDetail />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:agentId" element={<AgentDetail />} />
        <Route path="providers" element={<ProvidersPage />} />
        <Route path="orchestrations" element={<OrchestrationsPage />} />
        <Route
          path="orchestrations/:orchestrationId"
          element={<OrchestrationDetail />}
        />
        <Route path="runs" element={<RunsPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
