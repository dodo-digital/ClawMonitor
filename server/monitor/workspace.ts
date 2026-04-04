import { env } from "../lib/env.js";

export const DEFAULT_WORKSPACE_ID = "default";

export type MonitorWorkspace = {
  id: string;
  name: string;
  slug: string;
  mode: "monitor-only";
  openclawHome: string;
  openclawWorkspace: string;
};

export function getDefaultWorkspace(): MonitorWorkspace {
  return {
    id: DEFAULT_WORKSPACE_ID,
    name: "Default Workspace",
    slug: "default",
    mode: "monitor-only",
    openclawHome: env.openclawHome,
    openclawWorkspace: env.workspaceDir,
  };
}
