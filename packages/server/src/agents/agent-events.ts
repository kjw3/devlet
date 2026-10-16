/**
 * Agent-reported mission lifecycle events.
 *
 * The agent entrypoint POSTs process-boundary events (mission started /
 * completed / failed) to the server. This is the only source of truthful
 * task-activity state for the UI: free-form missions have no measurable
 * percentage, so the UI may only claim "in progress — waiting for a response"
 * while an event-reported run is open.
 *
 * Transport is fire-and-forget HTTP from the container; a missed event simply
 * means the UI falls back to runtime status (running/idle) without a task
 * claim. Events carry no mission content.
 */
import type { AgentState, MissionActivity } from "@devlet/shared";
import { loadAgentState, saveAgentState } from "./state.js";
import { validateAgentEventToken } from "./event-token.js";

export type AgentEventType = "mission_started" | "mission_completed" | "mission_failed";

const ACTIVITY_STATE_BY_EVENT: Record<AgentEventType, MissionActivity["state"]> = {
  mission_started: "started",
  mission_completed: "completed",
  mission_failed: "failed",
};

const LOG_LINE_BY_EVENT: Record<AgentEventType, string> = {
  mission_started: "[devlet] mission process started",
  mission_completed: "[devlet] mission process exited (code 0)",
  mission_failed: "[devlet] mission process exited (non-zero)",
};

export interface AgentEventInput {
  agentId: string;
  token: string;
  event: AgentEventType;
  /** ISO timestamp from the reporter; falls back to server time if absent/invalid. */
  at?: string;
}

export type AgentEventResult =
  | { ok: true }
  | { ok: false; statusCode: number; message: string };

function sanitizeTimestamp(value: string | undefined): string {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

export async function recordAgentEvent(input: AgentEventInput): Promise<AgentEventResult> {
  const { agentId, token, event } = input;
  if (!agentId || typeof agentId !== "string") {
    return { ok: false, statusCode: 400, message: "agentId is required" };
  }
  if (!validateAgentEventToken(agentId, token)) {
    return { ok: false, statusCode: 401, message: "invalid event token" };
  }

  let state: AgentState;
  try {
    state = await loadAgentState(agentId);
  } catch {
    return { ok: false, statusCode: 404, message: "agent not found" };
  }

  // Events only make sense for agents with a mission; interactive/persistent
  // agents without one report nothing.
  if (!state.config.mission.description) {
    return { ok: true };
  }

  const since = sanitizeTimestamp(input.at);
  state.missionProgress = {
    ...state.missionProgress,
    activity: { state: ACTIVITY_STATE_BY_EVENT[event], since },
  };
  state.config.lastActiveAt = since;
  state.logs.push(`${LOG_LINE_BY_EVENT[event]} at ${since}`);
  await saveAgentState(state);

  return { ok: true };
}
