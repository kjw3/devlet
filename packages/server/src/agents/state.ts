import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { TRPCError } from "@trpc/server";
import { AgentStateSchema, type AgentState, type AgentConfig, type Mission, type MissionProgress, type MissionStep, type PlatformTarget, type ResourceLimits, type GpuRequirements } from "@devlet/shared";

export const STATE_DIR = path.join(os.homedir(), ".devlet", "agents");

function getStatePath(id: string): string {
  return path.join(STATE_DIR, `${id}.yaml`);
}

function normalizePlatformTarget(platform: {
  type: "docker" | "portainer" | "proxmox";
  socketPath?: string;
  endpointId?: number;
  stackName?: string;
  node?: string;
  vmType?: "lxc" | "qemu";
}): PlatformTarget {
  if (platform.type === "docker") {
    return {
      type: "docker",
      ...(platform.socketPath !== undefined ? { socketPath: platform.socketPath } : {}),
    };
  }

  if (platform.type === "portainer") {
    return {
      type: "portainer",
      endpointId: platform.endpointId as number,
      ...(platform.stackName !== undefined ? { stackName: platform.stackName } : {}),
    };
  }

  return {
    type: "proxmox",
    node: platform.node as string,
    vmType: platform.vmType as "lxc" | "qemu",
  };
}

function normalizeResources(resources: {
  cpus: number;
  memoryMb: number;
  storageMb?: number;
}): ResourceLimits {
  return {
    cpus: resources.cpus,
    memoryMb: resources.memoryMb,
    ...(resources.storageMb !== undefined ? { storageMb: resources.storageMb } : {}),
  };
}

function normalizeGpu(gpu: {
  required: boolean;
  memoryMb?: number;
  passthroughMode?: "container" | "vm";
}): GpuRequirements {
  return {
    required: gpu.required,
    ...(gpu.memoryMb !== undefined ? { memoryMb: gpu.memoryMb } : {}),
    ...(gpu.passthroughMode !== undefined
      ? { passthroughMode: gpu.passthroughMode }
      : {}),
  };
}

function normalizeMissionStep(step: {
  action: string;
  params?: Record<string, unknown>;
  description?: string;
}): MissionStep {
  return {
    action: step.action,
    ...(step.params !== undefined ? { params: step.params } : {}),
    ...(step.description !== undefined ? { description: step.description } : {}),
  };
}

function normalizeMission(mission: {
  description: string;
  steps: Array<{
    action: string;
    params?: Record<string, unknown>;
    description?: string;
  }>;
  onComplete: "idle" | "terminate" | "report";
  timeout?: number;
}): Mission {
  return {
    description: mission.description,
    steps: mission.steps.map(normalizeMissionStep),
    onComplete: mission.onComplete,
    ...(mission.timeout !== undefined ? { timeout: mission.timeout } : {}),
  };
}

function normalizeMissionProgress(progress: {
  currentStep: number;
  completed: number[];
  startedAt: string;
  completedAt?: string;
}): MissionProgress {
  return {
    currentStep: progress.currentStep,
    completed: progress.completed,
    startedAt: progress.startedAt,
    ...(progress.completedAt !== undefined
      ? { completedAt: progress.completedAt }
      : {}),
  };
}

function normalizeAgentConfig(config: {
  id: string;
  name: string;
  type: AgentConfig["type"];
  role: string;
  mission: {
    description: string;
    steps: Array<{
      action: string;
      params?: Record<string, unknown>;
      description?: string;
    }>;
    onComplete: "idle" | "terminate" | "report";
    timeout?: number;
  };
  platform: {
    type: "docker" | "portainer" | "proxmox";
    socketPath?: string;
    endpointId?: number;
    stackName?: string;
    node?: string;
    vmType?: "lxc" | "qemu";
  };
  resources: {
    cpus: number;
    memoryMb: number;
    storageMb?: number;
  };
  gpu?: {
    required: boolean;
    memoryMb?: number;
    passthroughMode?: "container" | "vm";
  };
  env: Record<string, string>;
  persistent: boolean;
  createdAt: string;
  lastActiveAt: string;
}): AgentConfig {
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    role: config.role,
    mission: normalizeMission(config.mission),
    platform: normalizePlatformTarget(config.platform),
    resources: normalizeResources(config.resources),
    ...(config.gpu !== undefined ? { gpu: normalizeGpu(config.gpu) } : {}),
    env: config.env,
    persistent: config.persistent,
    createdAt: config.createdAt,
    lastActiveAt: config.lastActiveAt,
  };
}

function normalizeAgentState(state: {
  config: Parameters<typeof normalizeAgentConfig>[0];
  status: AgentState["status"];
  platformRef: string;
  missionProgress: {
    currentStep: number;
    completed: number[];
    startedAt: string;
    completedAt?: string;
  };
  logs: string[];
  error?: string;
}): AgentState {
  return {
    config: normalizeAgentConfig(state.config),
    status: state.status,
    platformRef: state.platformRef,
    missionProgress: normalizeMissionProgress(state.missionProgress),
    logs: state.logs,
    ...(state.error !== undefined ? { error: state.error } : {}),
  };
}

export async function ensureStateDir(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

export async function saveAgentState(state: AgentState): Promise<void> {
  await ensureStateDir();
  await fs.writeFile(getStatePath(state.config.id), yaml.dump(state), "utf8");
}

export async function loadAgentState(id: string): Promise<AgentState> {
  try {
    const content = await fs.readFile(getStatePath(id), "utf8");
    return normalizeAgentState(AgentStateSchema.parse(yaml.load(content)));
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : null;

    if (code === "ENOENT") {
      throw new TRPCError({ code: "NOT_FOUND" });
    }

    throw error;
  }
}

export async function listAgentStates(): Promise<AgentState[]> {
  await ensureStateDir();

  const entries = await fs.readdir(STATE_DIR, { withFileTypes: true });
  const states = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map(async (entry) => {
        try {
          const content = await fs.readFile(path.join(STATE_DIR, entry.name), "utf8");
          return normalizeAgentState(AgentStateSchema.parse(yaml.load(content)));
        } catch {
          return null;
        }
      })
  );

  return states.filter((state): state is AgentState => state !== null);
}

export async function deleteAgentState(id: string): Promise<void> {
  try {
    await fs.unlink(getStatePath(id));
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : null;

    if (code === "ENOENT") {
      return;
    }

    throw error;
  }
}
