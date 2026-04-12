export type MissionStepAction =
  | "clone_repo"
  | "install_deps"
  | "run_command"
  | "review_prs"
  | "create_pr"
  | "run_tests"
  | "deploy"
  | "notify"
  | string; // allow arbitrary actions

export interface MissionResult {
  agentId: string;
  missionDescription: string;
  status: "completed" | "partial" | "failed" | "timeout";
  stepsCompleted: number;
  stepsTotal: number;
  output?: string;
  error?: string;
  duration: number; // seconds
  completedAt: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  agentType: import("./agent.js").AgentType;
  description: string;
  defaultRole: string;
  defaultMission: import("./agent.js").Mission;
  defaultResources: import("./agent.js").ResourceLimits;
  dockerfileExists: boolean;
  bootstrapScriptExists: boolean;
}
