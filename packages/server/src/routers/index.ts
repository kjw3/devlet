import { initTRPC, TRPCError } from "@trpc/server";
import {
  scheduleAgent,
  HireAgentInputSchema,
  UpdateMissionInputSchema,
  SetDefaultInputSchema,
  SetAgentTypeConfigInputSchema,
  AgentTypeSchema,
  SetPortainerExclusionInputSchema,
  SetProxmoxExclusionInputSchema,
  AGENT_RESOURCE_MINS,
  type AgentConfig,
  type AgentState,
  type AppRouter as SharedAppRouter,
  type GpuRequirements,
  type Mission,
  type MissionStep,
  type PlatformTarget,
  type ResourceLimits,
} from "@devlet/shared";
import { randomUUID, timingSafeEqual } from "crypto";
import { z } from "zod";
import { listImages, probeDocker, allocateFreeOpenClawPort, allocateFreeTerminalPort, allocateFreeMoltisPort } from "../platforms/docker.js";
import { probePortainer } from "../platforms/portainer.js";
import { probeProxmox } from "../platforms/proxmox.js";
import { provisionAgent, stopAgent, removeAgent, getAgentLogs } from "../platforms/dispatch.js";
import {
  listAgentStates,
  loadAgentState,
  saveAgentState,
  deleteAgentState,
} from "../agents/state.js";
import { loadModelDefaults, saveModelDefaults } from "../models/config.js";
import { listProviders } from "../models/providers.js";
import { loadAgentTypeConfig, saveAgentTypeConfig } from "../agents/typeConfig.js";
import {
  loadEffectivePlatformExclusions,
  setPortainerExcluded,
  setProxmoxExcluded,
} from "../platforms/exclusions.js";

const t = initTRPC.context<{ authHeader?: string }>().create();
const AUTH_SCHEME = "Bearer ";
const INTERNAL_ONLY_ENV_KEYS = new Set([
  "DEVLET_TERMINAL_PORT",
  "DEVLET_TERMINAL_TOKEN",
  "OPENCLAW_HOST_PORT",
  "OPENCLAW_GATEWAY_TOKEN",
  "MOLTIS_HOST_PORT",
  "MOLTIS_PASSWORD",
]);
const SECRET_ENV_PATTERNS = [
  /(^|_)(API_KEY|TOKEN|PASSWORD|SECRET)$/i,
  /PRIVATE_KEY/i,
  /SESSION/i,
  /AUTH/i,
];

async function getPortainerEndpointHost(endpointId: number): Promise<string> {
  try {
    const status = await probePortainer();
    const endpoint = status.endpoints.find((item) => item.id === endpointId);
    if (!endpoint) return "localhost";

    if (endpoint.url.startsWith("unix://")) {
      return "localhost";
    }

    const normalized = endpoint.url.includes("://")
      ? endpoint.url
      : `tcp://${endpoint.url}`;
    return new URL(normalized).hostname || "localhost";
  } catch {
    return "localhost";
  }
}

function authenticateRequest(authHeader?: string): void {
  const expected = process.env["DEVLET_AUTH_TOKEN"];
  if (!expected) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Server auth is not configured" });
  }

  if (!authHeader?.startsWith(AUTH_SCHEME)) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  const received = authHeader.slice(AUTH_SCHEME.length);
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);

  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
}

const authProcedure = t.procedure.use(({ ctx, next }) => {
  authenticateRequest(ctx.authHeader);
  return next();
});

function sanitizeEnvValue(key: string, value: string): string | null {
  if (INTERNAL_ONLY_ENV_KEYS.has(key)) {
    return null;
  }

  if (SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
    return "[redacted]";
  }

  return value;
}

async function sanitizeAgentState(state: AgentState): Promise<AgentState> {
  const env = Object.fromEntries(
    Object.entries(state.config.env)
      .map(([key, value]) => [key, sanitizeEnvValue(key, value)] as const)
      .filter((entry): entry is [string, string] => entry[1] !== null)
  );

  let access: AgentState["access"];
  const terminalPort = state.config.env["DEVLET_TERMINAL_PORT"];
  const terminalToken = state.config.env["DEVLET_TERMINAL_TOKEN"];
  const openclawPort = state.config.env["OPENCLAW_HOST_PORT"];
  const openclawToken = state.config.env["OPENCLAW_GATEWAY_TOKEN"];
  const moltisPort = state.config.env["MOLTIS_HOST_PORT"];

  let host = "localhost";
  if (state.config.platform.type === "portainer") {
    host = await getPortainerEndpointHost(state.config.platform.endpointId);
  }

  if (terminalPort) {
    access = {
      ...access,
      terminal: {
        url: `http://${host}:${terminalPort}`,
        username: "devlet",
        ...(terminalToken ? { password: terminalToken } : {}),
      },
    };
  }

  if (state.config.type === "openclaw" && openclawPort) {
    access = {
      ...access,
      openclaw: {
        url: `http://${host}:${openclawPort}`,
        ...(openclawToken ? { token: openclawToken } : {}),
      },
    };
  }

  if (state.config.type === "moltis" && moltisPort) {
    access = {
      ...access,
      moltis: {
        url: `http://${host}:${moltisPort}`,
      },
    };
  }

  return {
    ...state,
    config: {
      ...state.config,
      env,
    },
    ...(access ? { access } : {}),
  };
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

export const appRouter = t.router({
  agents: t.router({
    list: authProcedure.query(async () => Promise.all((await listAgentStates()).map(sanitizeAgentState))),

    get: authProcedure.input(z.string()).query(async ({ input }) => sanitizeAgentState(await loadAgentState(input))),

    health: authProcedure.input(z.string()).query(async ({ input }) => {
      const state = await loadAgentState(input);

      // OpenClaw: plain HTTP health check
      if (state.config.type === "openclaw") {
        const port = state.config.env["OPENCLAW_HOST_PORT"];
        if (!port) return null;
        try {
          const res = await fetch(`http://localhost:${port}/healthz`, {
            signal: AbortSignal.timeout(3000),
          });
          return { ok: res.ok, httpStatus: res.status };
        } catch {
          return { ok: false, httpStatus: 0 };
        }
      }

      // Moltis: plain HTTP health check (TLS disabled in config).
      if (state.config.type === "moltis") {
        const port = state.config.env["MOLTIS_HOST_PORT"];
        if (!port) return null;
        try {
          const res = await fetch(`http://localhost:${port}/metrics`, {
            signal: AbortSignal.timeout(3000),
          });
          return { ok: res.ok, httpStatus: res.status };
        } catch {
          return { ok: false, httpStatus: 0 };
        }
      }

      return null;
    }),

    hire: authProcedure
      .input(HireAgentInputSchema)
      .mutation(async ({ input }) => {
        const mins = AGENT_RESOURCE_MINS[input.type];
        if (input.resources.cpus < mins.cpus) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${input.type} requires at least ${mins.cpus} CPU(s) (requested: ${input.resources.cpus})`,
          });
        }
        if (input.resources.memoryMb < mins.memoryMb) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${input.type} requires at least ${mins.memoryMb} MB RAM (requested: ${input.resources.memoryMb} MB)`,
          });
        }

        const [dockerStatus, portainerStatus, proxmoxStatus] = await Promise.all([
          probeDocker(),
          probePortainer(),
          probeProxmox(),
        ]);
        const schedulerContext = {
          docker: dockerStatus,
          portainer: portainerStatus.connected ? portainerStatus : null,
          proxmox: proxmoxStatus.connected ? proxmoxStatus : null,
        };

        const platform =
          input.platformOverride ??
          (() => {
            const decision = scheduleAgent(
              {
                type: input.type,
                resources: normalizeResources(input.resources),
                persistent: input.persistent,
                ...(input.gpu ? { gpu: normalizeGpu(input.gpu) } : {}),
              },
              schedulerContext
            );

            if (decision.outcome !== "scheduled" || !decision.placement) {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: decision.summary,
              });
            }

            return decision.placement;
          })();

        const id = `agent-${Math.random().toString(36).slice(2, 6)}`;
        const now = new Date().toISOString();

        const agentEnv: Record<string, string> = { ...input.env };

        // Pre-generate web terminal credentials for all agent types.
        if (!agentEnv["DEVLET_TERMINAL_PORT"]) {
          const port = await allocateFreeTerminalPort();
          agentEnv["DEVLET_TERMINAL_PORT"] = String(port);
        }
        if (!agentEnv["DEVLET_TERMINAL_TOKEN"]) {
          agentEnv["DEVLET_TERMINAL_TOKEN"] = randomUUID();
        }

        // OpenClaw: pre-generate gateway auth token and Control UI host port.
        if (input.type === "openclaw") {
          if (!agentEnv["OPENCLAW_GATEWAY_TOKEN"]) {
            agentEnv["OPENCLAW_GATEWAY_TOKEN"] = randomUUID();
          }
          if (!agentEnv["OPENCLAW_HOST_PORT"]) {
            const port = await allocateFreeOpenClawPort();
            agentEnv["OPENCLAW_HOST_PORT"] = String(port);
          }
        }

        // Moltis: allocate host port.
        if (input.type === "moltis") {
          if (!agentEnv["MOLTIS_HOST_PORT"]) {
            const port = await allocateFreeMoltisPort();
            agentEnv["MOLTIS_HOST_PORT"] = String(port);
          }
        }

        const config: AgentConfig = {
          id,
          name: input.name,
          type: input.type,
          role: input.role,
          mission: normalizeMission(input.mission),
          platform: normalizePlatformTarget(platform),
          resources: normalizeResources(input.resources),
          ...(input.gpu ? { gpu: normalizeGpu(input.gpu) } : {}),
          env: agentEnv,
          persistent: input.persistent,
          createdAt: now,
          lastActiveAt: now,
        };

        const state: AgentState = {
          config,
          status: "provisioning",
          platformRef: "pending",
          missionProgress: {
            currentStep: 0,
            completed: [],
            startedAt: now,
          },
          logs: ["Agent registered — awaiting provisioning"],
        };

        await saveAgentState(state);

        // Provision asynchronously so hire returns immediately
        provisionAgent(config)
          .then(async (platformRef) => {
            state.platformRef = platformRef;
            state.status = "running";
            state.logs.push(`Provisioned on ${config.platform.type}`);
            await saveAgentState(state);
          })
          .catch(async (err: unknown) => {
            state.status = "error";
            state.error = err instanceof Error ? err.message : String(err);
            state.logs.push(`Provisioning failed: ${state.error}`);
            await saveAgentState(state);
          });

        return sanitizeAgentState(state);
      }),

    fire: authProcedure.input(z.string()).mutation(async ({ input }) => {
      const state = await loadAgentState(input);
      await stopAgent(state.platformRef);
      await removeAgent(state.platformRef);
      state.status = "terminated";
      await saveAgentState(state);
    }),

    delete: authProcedure.input(z.string()).mutation(async ({ input }) => {
      // Best-effort container cleanup before removing state — handles both:
      //   • agents that exited naturally (container still exists as stopped)
      //   • agents already fired (container gone — stop/remove are no-ops)
      try {
        const state = await loadAgentState(input);
        await stopAgent(state.platformRef);
        await removeAgent(state.platformRef);
      } catch {
        // Non-fatal: proceed with state deletion regardless
      }
      await deleteAgentState(input);
    }),

    restart: authProcedure.input(z.string()).mutation(async ({ input }) => {
      const state = await loadAgentState(input);
      await stopAgent(state.platformRef);
      const platformRef = await provisionAgent(state.config);
      state.platformRef = platformRef;
      state.status = "running";
      state.config.lastActiveAt = new Date().toISOString();
      await saveAgentState(state);
      return sanitizeAgentState(state);
    }),

    logs: authProcedure.input(z.string()).query(async ({ input }) => {
      const state = await loadAgentState(input);
      return getAgentLogs(state.platformRef, state.logs);
    }),

    updateMission: authProcedure
      .input(UpdateMissionInputSchema)
      .mutation(() => {
        throw new TRPCError({ code: "NOT_IMPLEMENTED" });
      }),
  }),

  platforms: t.router({
    docker: t.router({
      status: authProcedure.query(async () => probeDocker()),
      images: authProcedure.query(async () => listImages()),
    }),

    portainer: t.router({
      status: authProcedure.query(() => probePortainer()),
      stacks: authProcedure.query(() => []),
      exclusions: authProcedure.query(() => loadEffectivePlatformExclusions()),
      setExcluded: authProcedure
        .input(SetPortainerExclusionInputSchema)
        .mutation(({ input }) => setPortainerExcluded(input.target, input.excluded)),
    }),

    proxmox: t.router({
      status: authProcedure.query(() => probeProxmox()),
      setExcluded: authProcedure
        .input(SetProxmoxExclusionInputSchema)
        .mutation(({ input }) => setProxmoxExcluded(input.target, input.excluded)),
    }),
  }),

  templates: t.router({
    list: authProcedure.query(() => []),
    get: authProcedure.input(z.string()).query(() => {
      throw new TRPCError({ code: "NOT_FOUND" });
    }),
  }),

  models: t.router({
    listProviders: authProcedure.query(async () => {
      const defaults = await loadModelDefaults();
      return listProviders(defaults);
    }),

    setDefault: authProcedure
      .input(SetDefaultInputSchema)
      .mutation(async ({ input }) => {
        const current = await loadModelDefaults();
        current.defaults[input.provider] = input.modelId;
        await saveModelDefaults(current);
        // Return the updated ProviderInfo for this provider
        const all = await listProviders(current);
        const updated = all.find((p) => p.id === input.provider);
        if (!updated) throw new TRPCError({ code: "NOT_FOUND" });
        return updated;
      }),
  }),

  agentConfig: t.router({
    list: authProcedure.query(async () => loadAgentTypeConfig()),

    set: authProcedure
      .input(SetAgentTypeConfigInputSchema)
      .mutation(async ({ input }) => {
        const current = await loadAgentTypeConfig();
        current.configs[input.agentType] = { provider: input.provider, model: input.model };
        await saveAgentTypeConfig(current);
        return current;
      }),

    clear: authProcedure
      .input(AgentTypeSchema)
      .mutation(async ({ input }) => {
        const current = await loadAgentTypeConfig();
        delete current.configs[input];
        await saveAgentTypeConfig(current);
        return current;
      }),
  }),
});

export type AppRouter = SharedAppRouter;
