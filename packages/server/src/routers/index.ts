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
import { AddSshKeyInputSchema } from "@devlet/shared";
import { listImages, probeDocker, allocateFreeOpenClawPort, allocateFreeSshPort, allocateFreeTerminalPort, allocateFreeMoltisPort } from "../platforms/docker.js";
import {
  allocateFreePortainerMoltisPort,
  allocateFreePortainerOpenClawPort,
  allocateFreePortainerSshPort,
  allocateFreePortainerTerminalPort,
  removePortainerContainerByName,
} from "../platforms/portainer-deploy.js";
import { probePortainer } from "../platforms/portainer.js";
import { probeProxmox } from "../platforms/proxmox.js";
import { provisionAgent, stopAgent, removeAgent, getAgentLogs } from "../platforms/dispatch.js";
import {
  listAgentStates,
  loadAgentState,
  saveAgentState,
  deleteAgentState,
} from "../agents/state.js";
import {
  buildAgentProxyUrl,
  resolveAgentAccessHost,
  resolveSurfaceTargetUrl,
} from "../agent-access.js";
import {
  generateAgentSshMaterial,
  getAgentSshAuthorizedKeys,
  isAgentSshEnabled,
} from "../agents/ssh.js";
import {
  listSshKeys,
  addSshKey,
  deleteSshKey,
} from "../ssh/keyStore.js";
import { loadModelDefaults, saveModelDefaults } from "../models/config.js";
import { config as appConfig } from "../config.js";
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
  "DEVLET_SSH_PORT",
  "DEVLET_SSH_USERNAME",
  "DEVLET_SSH_AUTHORIZED_KEYS_B64",
  "DEVLET_SSH_HOST_KEY_PRIVATE_B64",
  "DEVLET_SSH_HOST_KEY_PUBLIC_B64",
  "DEVLET_SSH_HOST_KEY_FINGERPRINT",
  "OPENCLAW_HOST_PORT",
  "OPENCLAW_ALLOWED_ORIGINS",
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

function getMoltisInitialPassword(config: AgentConfig): string {
  return config.env["MOLTIS_PASSWORD"] ?? `devlet-${config.name}`;
}

async function sanitizeAgentState(state: AgentState): Promise<AgentState> {
  const env = Object.fromEntries(
    Object.entries(state.config.env)
      .map(([key, value]) => [key, sanitizeEnvValue(key, value)] as const)
      .filter((entry): entry is [string, string] => entry[1] !== null)
  );

  let access: AgentState["access"];
  const terminalPort = state.config.env["DEVLET_TERMINAL_PORT"];
  const sshPort = state.config.env["DEVLET_SSH_PORT"];
  const sshUsername = state.config.env["DEVLET_SSH_USERNAME"] ?? "agent";
  const sshFingerprint = state.config.env["DEVLET_SSH_HOST_KEY_FINGERPRINT"];
  const openclawPort = state.config.env["OPENCLAW_HOST_PORT"];
  const openclawToken = state.config.env["OPENCLAW_GATEWAY_TOKEN"];
  const terminalTarget = await resolveSurfaceTargetUrl(state, "terminal");
  const openclawTarget = await resolveSurfaceTargetUrl(state, "openclaw");
  const moltisTarget = await resolveSurfaceTargetUrl(state, "moltis");
  const sshHost = sshPort ? await resolveAgentAccessHost(state.config.platform) : null;

  if (terminalPort && terminalTarget) {
    access = {
      ...access,
      terminal: {
        url: buildAgentProxyUrl(state.config.id, "terminal", terminalTarget),
      },
    };
  }

  if (sshPort && sshHost) {
    access = {
      ...access,
      ssh: {
        host: sshHost,
        port: Number(sshPort),
        username: sshUsername,
        ...(sshFingerprint ? { hostKeyFingerprint: sshFingerprint } : {}),
      },
    };
  }

  if (state.config.type === "openclaw" && openclawPort && openclawTarget) {
    // Use direct URL rather than the devlet HMAC proxy. OpenClaw is a WebSocket-heavy
    // SPA: its frontend constructs absolute-path WS URLs that bypass the proxy prefix,
    // causing 1006 disconnects. OpenClaw's own gateway token (passed as #token=… by
    // the UI) provides authentication, so the proxy layer is not needed here.
    access = {
      ...access,
      openclaw: {
        url: openclawTarget,
        ...(openclawToken ? { token: openclawToken } : {}),
      },
    };
  }

  if (state.config.type === "moltis" && moltisTarget) {
    // Same reasoning as openclaw — direct URL avoids path-prefix WebSocket issues.
    access = {
      ...access,
      moltis: {
        url: moltisTarget,
        password: getMoltisInitialPassword(state.config),
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

async function ensureAgentAccessPorts(config: AgentConfig, sshEnabled: boolean): Promise<void> {
  if (config.platform.type === "portainer") {
    if (!config.env["DEVLET_TERMINAL_PORT"]) {
      config.env["DEVLET_TERMINAL_PORT"] = String(
        await allocateFreePortainerTerminalPort(config.platform.endpointId)
      );
    }
    if (sshEnabled && !config.env["DEVLET_SSH_PORT"]) {
      config.env["DEVLET_SSH_PORT"] = String(
        await allocateFreePortainerSshPort(config.platform.endpointId)
      );
    }
    if (config.type === "openclaw" && !config.env["OPENCLAW_HOST_PORT"]) {
      config.env["OPENCLAW_HOST_PORT"] = String(
        await allocateFreePortainerOpenClawPort(config.platform.endpointId)
      );
    }
    if (config.type === "moltis" && !config.env["MOLTIS_HOST_PORT"]) {
      config.env["MOLTIS_HOST_PORT"] = String(
        await allocateFreePortainerMoltisPort(config.platform.endpointId)
      );
    }
    return;
  }

  if (!config.env["DEVLET_TERMINAL_PORT"]) {
    config.env["DEVLET_TERMINAL_PORT"] = String(await allocateFreeTerminalPort());
  }
  if (sshEnabled && !config.env["DEVLET_SSH_PORT"]) {
    config.env["DEVLET_SSH_PORT"] = String(await allocateFreeSshPort());
  }
  if (config.type === "openclaw" && !config.env["OPENCLAW_HOST_PORT"]) {
    config.env["OPENCLAW_HOST_PORT"] = String(await allocateFreeOpenClawPort());
  }
  if (config.type === "moltis" && !config.env["MOLTIS_HOST_PORT"]) {
    config.env["MOLTIS_HOST_PORT"] = String(await allocateFreeMoltisPort());
  }
}

async function ensureAgentAccessEnv(config: AgentConfig): Promise<void> {
  // Merge env-var keys with persistently stored keys first, so we know
  // whether SSH should be enabled before allocating ports.
  const storedKeys = await listSshKeys();
  const envKeys = getAgentSshAuthorizedKeys();
  const allAuthorizedKeys = [
    ...(envKeys ? [envKeys] : []),
    ...storedKeys.map((k) => k.publicKey),
  ].join("\n").trim();

  const sshEnabled = isAgentSshEnabled() || storedKeys.length > 0;
  await ensureAgentAccessPorts(config, sshEnabled);

  if (sshEnabled) {
    if (!config.env["DEVLET_SSH_HOST_KEY_PRIVATE_B64"] || !config.env["DEVLET_SSH_HOST_KEY_PUBLIC_B64"]) {
      const sshMaterial = await generateAgentSshMaterial(config.id);
      config.env["DEVLET_SSH_HOST_KEY_PRIVATE_B64"] = Buffer.from(sshMaterial.privateKey, "utf8").toString("base64");
      config.env["DEVLET_SSH_HOST_KEY_PUBLIC_B64"] = Buffer.from(sshMaterial.publicKey, "utf8").toString("base64");
      config.env["DEVLET_SSH_HOST_KEY_FINGERPRINT"] = sshMaterial.fingerprint;
    }
    if (!config.env["DEVLET_SSH_AUTHORIZED_KEYS_B64"]) {
      config.env["DEVLET_SSH_AUTHORIZED_KEYS_B64"] = Buffer.from(allAuthorizedKeys, "utf8").toString("base64");
    }
    if (!config.env["DEVLET_SSH_USERNAME"]) {
      config.env["DEVLET_SSH_USERNAME"] = "agent";
    }
  }

  if (config.type === "openclaw") {
    // OpenClaw is accessed via direct URL (not the devlet proxy) because its
    // frontend uses absolute paths for assets and WebSocket that a path-prefix
    // proxy cannot reroute. The browser origin is therefore the direct host:port
    // URL, not the devlet publicBaseUrl. Inject both so the agent still works if
    // accessed through a browser that somehow has the devlet URL as origin.
    const openclawHostPort = config.env["OPENCLAW_HOST_PORT"];
    const agentHost = await resolveAgentAccessHost(config.platform);
    const directOrigin = openclawHostPort ? `http://${agentHost}:${openclawHostPort}` : null;
    const allowedOrigins = [new URL(appConfig.publicBaseUrl).origin];
    if (directOrigin) allowedOrigins.push(directOrigin);
    config.env["OPENCLAW_ALLOWED_ORIGINS"] = allowedOrigins.join(",");
    if (!config.env["OPENCLAW_TRUSTED_PROXIES"]) {
      config.env["OPENCLAW_TRUSTED_PROXIES"] = [
        "127.0.0.1/32",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
      ].join(",");
    }
  }

  if (config.type === "moltis" && !config.env["MOLTIS_PASSWORD"]) {
    config.env["MOLTIS_PASSWORD"] = getMoltisInitialPassword(config);
  }
}

async function refreshAgentAccessPorts(config: AgentConfig): Promise<void> {
  delete config.env["DEVLET_TERMINAL_PORT"];
  delete config.env["DEVLET_SSH_PORT"];
  if (config.type === "openclaw") delete config.env["OPENCLAW_HOST_PORT"];
  if (config.type === "moltis") delete config.env["MOLTIS_HOST_PORT"];
  if (config.type === "openclaw") {
    delete config.env["OPENCLAW_ALLOWED_ORIGINS"];
    delete config.env["OPENCLAW_TRUSTED_PROXIES"];
  }
  await ensureAgentAccessEnv(config);
}

export const appRouter = t.router({
  agents: t.router({
    list: authProcedure.query(async () => Promise.all((await listAgentStates()).map(sanitizeAgentState))),

    get: authProcedure.input(z.string()).query(async ({ input }) => sanitizeAgentState(await loadAgentState(input))),

    health: authProcedure.input(z.string()).query(async ({ input }) => {
      const state = await loadAgentState(input);

      // OpenClaw: plain HTTP health check
      if (state.config.type === "openclaw") {
        const target = await resolveSurfaceTargetUrl(state, "openclaw");
        if (!target) return null;
        try {
          const res = await fetch(new URL("/healthz", target), {
            signal: AbortSignal.timeout(3000),
          });
          return { ok: res.ok, httpStatus: res.status };
        } catch {
          return { ok: false, httpStatus: 0 };
        }
      }

      // Moltis: plain HTTP health check (TLS disabled in config).
      if (state.config.type === "moltis") {
        const target = await resolveSurfaceTargetUrl(state, "moltis");
        if (!target) return null;
        try {
          const res = await fetch(new URL("/metrics", target), {
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

        // Inject all provider credentials configured on the server so every
        // agent has access to all tools in the base image, regardless of which
        // agent type was selected at hire time.  Client-supplied values take
        // precedence (don't overwrite).
        const PROVIDER_CREDENTIAL_KEYS = [
          "ANTHROPIC_API_KEY",
          "OPENAI_API_KEY",
          "GEMINI_API_KEY",
          "GOOGLE_GENERATIVE_AI_API_KEY",
          "OPENROUTER_API_KEY",
          "NVIDIA_API_KEY",
          "LITELLM_API_KEY",
          "LITELLM_BASE_URL",
        ] as const;
        for (const key of PROVIDER_CREDENTIAL_KEYS) {
          const val = process.env[key];
          if (val && !agentEnv[key]) {
            agentEnv[key] = val;
          }
        }

        if (input.type === "openclaw") {
          if (!agentEnv["OPENCLAW_GATEWAY_TOKEN"]) {
            agentEnv["OPENCLAW_GATEWAY_TOKEN"] = randomUUID();
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
        await ensureAgentAccessEnv(config);

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
      // Swallow stop/remove errors — container may already be gone (terminated state).
      await stopAgent(state.platformRef).catch(() => {});
      await removeAgent(state.platformRef).catch(() => {});
      if (state.config.platform.type === "portainer") {
        await removePortainerContainerByName(
          state.config.platform.endpointId,
          `devlet-${state.config.id}`
        ).catch(() => {});
      }
      await refreshAgentAccessPorts(state.config);
      const platformRef = await provisionAgent(state.config);
      state.platformRef = platformRef;
      state.status = "running";
      delete state.error;
      state.config.lastActiveAt = new Date().toISOString();
      state.logs.push(`${state.status === "terminated" ? "Start" : "Restart"} requested — reprovisioning agent`);
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

  settings: t.router({
    ssh: t.router({
      listKeys: authProcedure.query(async () => listSshKeys()),

      addKey: authProcedure
        .input(AddSshKeyInputSchema)
        .mutation(async ({ input }) => {
          try {
            return await addSshKey(input.name, input.publicKey);
          } catch (err) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }),

      deleteKey: authProcedure
        .input(z.string())
        .mutation(async ({ input }) => {
          await deleteSshKey(input);
        }),
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
