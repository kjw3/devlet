import type { AgentType, ResourceLimits } from "./agent.js";
import type { PlatformTarget } from "./platform.js";

// ─── What the agent needs ────────────────────────────────────────────────────

export interface GpuRequirements {
  required: boolean;
  memoryMb?: number;          // minimum GPU memory
  passthroughMode?: "container" | "vm";
}

/** The scheduler reads these to decide where to place an agent. */
export interface PlacementRequirements {
  type: AgentType;
  resources: ResourceLimits;
  persistent: boolean;
  gpu?: GpuRequirements;
}

// ─── Per-platform evaluation ──────────────────────────────────────────────────

export interface PlatformScore {
  platform: PlatformTarget;
  score: number;             // 0–100
  available: boolean;        // false = hard constraint failed (disconnected, no GPU, etc.)
  reasons: string[];         // human-readable bullets shown in UI
  disqualifyReason?: string; // why it was skipped (shown greyed out)
}

// ─── Scheduler output ─────────────────────────────────────────────────────────

export type PlacementOutcome = "scheduled" | "queued" | "no-platforms";

export interface PlacementDecision {
  outcome: PlacementOutcome;
  /** Winning placement — present when outcome === 'scheduled' */
  placement?: PlatformTarget;
  /** Winning score entry — present when outcome === 'scheduled' */
  winner?: PlatformScore;
  /** All evaluated platforms, sorted best → worst */
  scores: PlatformScore[];
  /** Human-readable one-liner for the UI */
  summary: string;
}

// ─── Scheduler input ──────────────────────────────────────────────────────────

export interface SchedulerContext {
  docker: import("./platform.js").DockerStatus | null;
  portainer: import("./platform.js").PortainerStatus | null;
  proxmox: import("./platform.js").ProxmoxStatus | null;
}
