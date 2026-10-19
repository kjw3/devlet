import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { TRPCError } from "@trpc/server";
import { AgentStateSchema, type AgentState, type AgentConfig, type Mission, type MissionProgress, type MissionStep, type PlatformTarget, type ResourceLimits, type GpuRequirements } from "@devlet/shared";

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".devlet", "agents");

/**
 * Agent state directory. `DEVLET_STATE_DIR` overrides it (used by tests for
 * hermetic runs); resolved at call time so test env changes take effect.
 */
export function getStateDir(): string {
  return process.env["DEVLET_STATE_DIR"] ?? DEFAULT_STATE_DIR;
}

/** @deprecated legacy constant export — prefer getStateDir(). */
export const STATE_DIR = DEFAULT_STATE_DIR;

function getStatePath(id: string): string {
  return path.join(getStateDir(), `${id}.yaml`);
}

function normalizePlatformTarget(platform: {
  type: "docker" | "portainer" | "proxmox" | "komodo";
  socketPath?: string;
  endpointId?: number;
  stackName?: string;
  node?: string;
  vmType?: "lxc" | "qemu";
  serverId?: string;
  serverName?: string;
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

  if (platform.type === "komodo") {
    return {
      type: "komodo",
      serverId: platform.serverId as string,
      ...(platform.serverName !== undefined ? { serverName: platform.serverName } : {}),
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
  devices?: string[];
}): GpuRequirements {
  return {
    required: gpu.required,
    ...(gpu.memoryMb !== undefined ? { memoryMb: gpu.memoryMb } : {}),
    ...(gpu.passthroughMode !== undefined
      ? { passthroughMode: gpu.passthroughMode }
      : {}),
    // Specific GPUs picked in the hire wizard (GPU UUIDs on container
    // platforms, PCI ids on Proxmox). Dropping these would silently broaden a
    // restricted assignment to every GPU of the host on the next load+save
    // (recovery, rebuild, reconciliation). An empty array is equivalent to
    // "all GPUs" (see gpuRunArg/gpuDeviceRequests), so it is dropped like the
    // hire-path normalizer does.
    ...(gpu.devices?.length ? { devices: gpu.devices } : {}),
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
  activity?: MissionProgress["activity"];
}): MissionProgress {
  return {
    currentStep: progress.currentStep,
    completed: progress.completed,
    startedAt: progress.startedAt,
    ...(progress.completedAt !== undefined
      ? { completedAt: progress.completedAt }
      : {}),
    ...(progress.activity !== undefined
      ? { activity: progress.activity }
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
    type: "docker" | "portainer" | "proxmox" | "komodo";
    socketPath?: string;
    endpointId?: number;
    stackName?: string;
    node?: string;
    vmType?: "lxc" | "qemu";
    serverId?: string;
    serverName?: string;
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
    devices?: string[];
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
    activity?: MissionProgress["activity"];
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
  await fs.mkdir(getStateDir(), { recursive: true });
}

export async function saveAgentState(state: AgentState): Promise<void> {
  await ensureStateDir();
  // Atomic write: dump to a unique temp file in the same directory, then
  // rename over the target. A crash mid-write can never leave a truncated or
  // partially-written YAML file behind (rename is atomic on POSIX).
  const target = getStatePath(state.config.id);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, yaml.dump(state), "utf8");
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
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

  const entries = await fs.readdir(getStateDir(), { withFileTypes: true });
  const states = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map(async (entry) => {
        try {
          const content = await fs.readFile(path.join(getStateDir(), entry.name), "utf8");
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
