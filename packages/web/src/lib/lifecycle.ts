import type { AgentState, AgentStatus } from "@devlet/shared";

/**
 * Dashboard grouping of agent statuses by where they are in their life.
 *
 * The server only ever assigns provisioning → running (or error) and, once an
 * agent is fired or its container exits, terminated. `bootstrapping` and `idle`
 * exist in the type but are never set, so they are folded into the nearest
 * group rather than shown as filters that are always empty.
 */
export type Lifecycle = "starting" | "running" | "attention" | "stopped";

export const LIFECYCLE_ORDER: Lifecycle[] = ["attention", "starting", "running", "stopped"];

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  starting: "starting",
  running: "running",
  attention: "needs attention",
  stopped: "stopped",
};

const STATUS_TO_LIFECYCLE: Record<AgentStatus, Lifecycle> = {
  provisioning: "starting",
  bootstrapping: "starting",
  running: "running",
  idle: "running",
  error: "attention",
  terminated: "stopped",
};

export function lifecycleOf(status: AgentStatus): Lifecycle {
  return STATUS_TO_LIFECYCLE[status];
}

/**
 * Long-running agents stay up after their mission (or have none); task agents
 * are configured to terminate when the mission completes.
 */
export type AgentKind = "long-running" | "task";

export function kindOf(agent: AgentState): AgentKind {
  return agent.config.mission.onComplete === "terminate" ? "task" : "long-running";
}

/** Needs-attention first, then starting, running, stopped; newest activity first within a group. */
export function sortByLifecycle(agents: AgentState[]): AgentState[] {
  const rank = (a: AgentState) => LIFECYCLE_ORDER.indexOf(lifecycleOf(a.status));
  const recency = (a: AgentState) =>
    Date.parse(a.config.lastActiveAt ?? a.config.createdAt ?? "") || 0;
  return agents.slice().sort((a, b) => rank(a) - rank(b) || recency(b) - recency(a));
}

export type MissionActivityView = {
  label: string;
  /** "active" pulses; "done"/"failed" are static. */
  tone: "active" | "done" | "failed";
};

/**
 * Truthful task-activity line for an agent with a mission. Free-form missions
 * have no measurable percentage — the only execution signal is the agent's own
 * reported process lifecycle, plus runtime status as a fallback. Never returns
 * progress percentages or invented step counts.
 */
export function missionActivityView(agent: AgentState): MissionActivityView | null {
  if (!agent.config.mission.description) return null;
  if (agent.status === "provisioning" || agent.status === "bootstrapping") return null;

  const activity = agent.missionProgress?.activity;
  if (agent.status === "error") {
    return { label: "Mission interrupted", tone: "failed" };
  }
  if (agent.status === "terminated") {
    return { label: "Mission ended", tone: "done" };
  }

  if (activity?.state === "completed") {
    return { label: "Mission complete", tone: "done" };
  }
  if (activity?.state === "failed") {
    return { label: "Mission failed — check logs", tone: "failed" };
  }
  if (agent.status === "running" || agent.status === "idle") {
    if (activity?.state === "started") {
      // The mission process is open: the agent is executing or awaiting a model
      // response — not distinguishable from outside the container.
      return { label: "Task in progress — waiting for a response.", tone: "active" };
    }
    // Mission was dispatched with the container; no process-level signal yet.
    return { label: "Mission dispatched", tone: "active" };
  }
  return null;
}
