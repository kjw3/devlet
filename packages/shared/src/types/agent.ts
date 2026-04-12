import type { PlatformTarget } from "./platform.js";
import type { GpuRequirements } from "./scheduler.js";

export type AgentType =
  | "claude-code"
  | "codex"
  | "openclaw"
  | "nemoclaw"
  | "hermes";

export type AgentStatus =
  | "provisioning"
  | "bootstrapping"
  | "running"
  | "idle"
  | "terminated"
  | "error";

export type OnComplete = "idle" | "terminate" | "report";

export interface MissionStep {
  action: string;
  params?: Record<string, unknown>;
  description?: string;
}

export interface MissionProgress {
  currentStep: number;
  completed: number[];
  startedAt: string;
  completedAt?: string;
}

export interface Mission {
  description: string;
  steps: MissionStep[];
  onComplete: OnComplete;
  timeout?: number; // seconds
}

export interface ResourceLimits {
  cpus: number;
  memoryMb: number;
  storageMb?: number;
}

export interface AgentConfig {
  id: string;
  name: string;
  type: AgentType;
  role: string;
  mission: Mission;
  /**
   * Resolved placement — set by the scheduler at hire time.
   * Never set manually by the user.
   */
  platform: PlatformTarget;
  resources: ResourceLimits;
  /** GPU requirements — drives scheduler placement decisions. */
  gpu?: GpuRequirements;
  env: Record<string, string>;
  persistent: boolean;
  createdAt: string;
  lastActiveAt: string;
}

export interface AgentState {
  config: AgentConfig;
  status: AgentStatus;
  platformRef: string; // container ID, VM ID, etc.
  missionProgress: MissionProgress;
  logs: string[];
  error?: string;
}

// Re-export platform types for convenience
export type { PlatformTarget } from "./platform.js";
