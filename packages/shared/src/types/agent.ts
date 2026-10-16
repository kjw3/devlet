import type { PlatformTarget } from "./platform.js";
import type { GpuRequirements } from "./scheduler.js";

export type AgentType =
  | "claude-code"
  | "codex"
  | "opencode"
  | "pi"
  | "gemini"
  | "openclaw"
  | "nanoclaw"
  | "hermes"
  | "moltis"
  | "nemoclaw"; // future: NVIDIA NeMo — Proxmox GPU VM only

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
  /**
   * Truthful runtime activity, reported by the agent entrypoint at process
   * boundaries. Free-form missions have no percentage — this is the only
   * execution signal the UI may display. Absent for agents hired before this
   * field existed or for agents without a mission.
   */
  activity?: MissionActivity;
}

/**
 * Mission execution lifecycle as observed by the agent itself:
 * - `started`: the mission process was launched (it is executing or awaiting a
 *   model response — not distinguishable from outside the container).
 * - `completed` / `failed`: the mission process exited (with code 0 / non-zero).
 */
export interface MissionActivity {
  state: "started" | "completed" | "failed";
  since: string; // ISO timestamp of the last reported transition
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
  access?: {
    terminal?: {
      url: string;
    };
    ssh?: {
      host: string;
      port: number;
      username: string;
      hostKeyFingerprint?: string;
    };
    tailscale?: {
      hostname: string;
      /** MagicDNS name, e.g. devlet-agent-ab12.tailnet.ts.net */
      fqdn: string;
      ip?: string;
      ssh: boolean;
      urls: {
        terminal?: string;
        openclaw?: string;
        moltis?: string;
      };
    };
    openclaw?: {
      url: string;
      token?: string;
    };
    moltis?: {
      url: string;
      password?: string;
    };
  };
}

// Re-export platform types for convenience
export type { PlatformTarget } from "./platform.js";
