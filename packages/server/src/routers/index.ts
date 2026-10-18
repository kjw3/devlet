import { initTRPC, TRPCError } from "@trpc/server";
import {
  scheduleAgent,
  PlatformTargetSchema,
  getHostCapacity,
  getResourceMinimum,
  resourceCapacityError,
  HireAgentInputSchema,
  UpdateMissionInputSchema,
  RecoverAgentInputSchema,
  SetDefaultInputSchema,
  SetAgentTypeConfigInputSchema,
  AgentTypeSchema,
  SetPortainerExclusionInputSchema,
  SetProxmoxExclusionInputSchema,
  SetKomodoExclusionInputSchema,
  AGENT_RESOURCE_MINS,
  AGENT_TYPE_LABELS,
  DISABLED_AGENT_TYPES,
  type AgentConfig,
  type AgentState,
  type AppRouter as SharedAppRouter,
  type GpuRequirements,
  type Mission,
  type MissionStep,
  type PlatformTarget,
  type ResourceLimits,
} from "@devlet/shared";
import { getDiskCapacity } from "../platforms/disk.js";
import { admitAgent } from "../agents/disk-admission.js";
import { randomUUID, timingSafeEqual } from "crypto";
import { z } from "zod";
import { AddSshKeyInputSchema } from "@devlet/shared";
import {
  allocateFreeKomodoMoltisPort,
  allocateFreeKomodoOpenClawPort,
  allocateFreeKomodoSshPort,
  allocateFreeKomodoTerminalPort,
} from "../platforms/komodo-deploy.js";
import { listImages, probeDocker, allocateFreeOpenClawPort, allocateFreeSshPort, allocateFreeTerminalPort, allocateFreeMoltisPort } from "../platforms/docker.js";
import {
  allocateFreePortainerMoltisPort,
  allocateFreePortainerOpenClawPort,
  allocateFreePortainerSshPort,
  allocateFreePortainerTerminalPort,
  removePortainerContainerByName,
} from "../platforms/portainer-deploy.js";
import { probePortainer } from "../platforms/portainer.js";
import { probeProxmox, validateProxmoxPlacement } from "../platforms/proxmox.js";
import { countGpuClaims, pickDefaultGpuDevices, resolveHostGpuDevices, validateGpuDeviceIds } from "../platforms/gpu-selection.js";
import { probeKomodo, probeKomodoCached } from "../platforms/komodo.js";
import { isServerOnTailnet } from "../tailscale/node.js";
import { findAgentDevice, probeTailscale, removeAgentDevices, isTailscaleEnabledFor } from "../tailscale/client.js";
import { provisionAgent, stopAgent, startAgent, removeAgent, removeAgentVolumes, getAgentLogs, removeOrphanedProvision } from "../platforms/dispatch.js";
import { listAgentStates, loadAgentState, saveAgentState, deleteAgentState } from "../agents/state.js";
import { sanitizeEnv, sanitizeAgentStateSummary } from "../agents/sanitize.js";
import {
  buildAgentSubdomainUrl,
  buildAgentAccessUrlForTarget,
  buildResolvedAgentSubdomainUrl,
  resolveAgentAccessHost,
  resolveProxmoxAgentHost,
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
  setKomodoExcluded,
} from "../platforms/exclusions.js";

const t = initTRPC.context<{ authHeader?: string }>().create();
const AUTH_SCHEME = "Bearer ";

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

function getMoltisInitialPassword(config: AgentConfig): string {
  return config.env["MOLTIS_PASSWORD"] ?? `devlet-${config.name}`;
}

/**
 * Detail-level enrichment: resolves connection surfaces for ONE agent.
 *
 * The host is resolved at most once, and inapplicable surfaces are skipped
 * before any remote work (an agent without an SSH port never pays for host
 * resolution just to answer SSH). This is only used by `agents.get` — the
 * list path stays pure via `sanitizeAgentStateSummary`.
 */
async function enrichAgentAccess(state: AgentState): Promise<AgentState> {
  const env = sanitizeEnv(state.config.env);
  const config = { ...state.config, env };

  if (state.status !== "running" && state.status !== "idle") {
    return { ...state, config };
  }

  // Internal runtime vars are read from the RAW env — sanitizeEnv removes them
  // from the serialized copy because they are not for display.
  const rawEnv = state.config.env;
  const terminalPort = rawEnv["DEVLET_TERMINAL_PORT"];
  const sshPort = rawEnv["DEVLET_SSH_PORT"];
  const sshUsername = rawEnv["DEVLET_SSH_USERNAME"] ?? "agent";
  const sshFingerprint = rawEnv["DEVLET_SSH_HOST_KEY_FINGERPRINT"];
  const openclawPort = rawEnv["OPENCLAW_HOST_PORT"];
  const openclawToken = rawEnv["OPENCLAW_GATEWAY_TOKEN"];
  const moltisPort = rawEnv["MOLTIS_HOST_PORT"];
  const wantsOpenclaw = state.config.type === "openclaw" && Boolean(openclawPort);
  const wantsMoltis = state.config.type === "moltis";
  const wantsHost = Boolean(terminalPort || sshPort || wantsOpenclaw || wantsMoltis);

  let access: AgentState["access"];

  if (wantsHost) {
    // Single host resolution for every surface of this agent.
    const host = await resolveAccessHostForAgent(state.config.platform, state.config.id);
    const targetFor = (port?: string) => (host && port ? `http://${host}:${port}` : null);
    const terminalTarget = targetFor(terminalPort);
    const openclawTarget = wantsOpenclaw ? targetFor(openclawPort) : null;
    const moltisTarget = wantsMoltis ? targetFor(moltisPort) : null;

    if (terminalPort && terminalTarget) {
      access = {
        ...access,
        terminal: {
          url: buildAgentAccessUrlForTarget(state.config, "terminal", terminalTarget),
        },
      };
    }

    if (sshPort && host) {
      access = {
        ...access,
        ssh: {
          host,
          port: Number(sshPort),
          username: sshUsername,
          ...(sshFingerprint ? { hostKeyFingerprint: sshFingerprint } : {}),
        },
      };
    }

    if (wantsOpenclaw && openclawTarget) {
      access = {
        ...access,
        openclaw: {
          url: buildAgentSubdomainUrl(state.config.id, "openclaw", openclawTarget) ?? openclawTarget,
          ...(openclawToken ? { token: openclawToken } : {}),
        },
      };
    }

    if (wantsMoltis && moltisTarget) {
      access = {
        ...access,
        moltis: {
          url: buildAgentSubdomainUrl(state.config.id, "moltis", moltisTarget) ?? moltisTarget,
          password: getMoltisInitialPassword(state.config),
        },
      };
    }
  }

  if (isTailscaleEnabledFor(state.config)) {
    const device = await findAgentDevice(state.config.id).catch(() => null);
    if (device) {
      const base = `https://${device.name.replace(/\.$/, "")}`;
      const ip = device.addresses.find((addr) => !addr.includes(":"));
      access = {
        ...access,
        tailscale: {
          hostname: device.hostname,
          fqdn: device.name.replace(/\.$/, ""),
          ...(ip ? { ip } : {}),
          ssh: state.config.env["TS_SSH"] !== "false",
          urls: {
            ...(terminalPort ? { terminal: `${base}/` } : {}),
            ...(state.config.type === "openclaw" ? { openclaw: `${base}:8443/` } : {}),
            ...(state.config.type === "moltis" ? { moltis: `${base}:8443/` } : {}),
          },
        },
      };
    }
  }

  return {
    ...state,
    config,
    ...(access ? { access } : {}),
  };
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

/** Host for direct access (SSH command display, OpenClaw origins): guest IP for
 *  Proxmox agents, platform host for the others. Empty when not resolvable yet. */
async function resolveAccessHostForAgent(platform: PlatformTarget, agentId: string): Promise<string> {
  if (platform.type === "proxmox") return resolveProxmoxAgentHost(platform, agentId);
  return resolveAgentAccessHost(platform);
}

async function ensureAgentAccessPorts(config: AgentConfig, sshEnabled: boolean): Promise<void> {
  if (config.platform.type === "proxmox") {
    // One dedicated guest per agent — fixed container ports, no host-range
    // allocation race (docs/proxmox-provisioning.md, D4).
    if (!config.env["DEVLET_TERMINAL_PORT"]) config.env["DEVLET_TERMINAL_PORT"] = "7681";
    if (sshEnabled && !config.env["DEVLET_SSH_PORT"]) config.env["DEVLET_SSH_PORT"] = "2222";
    if (config.type === "openclaw" && !config.env["OPENCLAW_HOST_PORT"]) {
      config.env["OPENCLAW_HOST_PORT"] = "18789";
    }
    if (config.type === "moltis" && !config.env["MOLTIS_HOST_PORT"]) {
      config.env["MOLTIS_HOST_PORT"] = "13131";
    }
    return;
  }

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

  if (config.platform.type === "komodo") {
    const serverId = config.platform.serverId;
    if (!config.env["DEVLET_TERMINAL_PORT"]) {
      config.env["DEVLET_TERMINAL_PORT"] = String(await allocateFreeKomodoTerminalPort(serverId));
    }
    if (sshEnabled && !config.env["DEVLET_SSH_PORT"]) {
      config.env["DEVLET_SSH_PORT"] = String(await allocateFreeKomodoSshPort(serverId));
    }
    if (config.type === "openclaw" && !config.env["OPENCLAW_HOST_PORT"]) {
      config.env["OPENCLAW_HOST_PORT"] = String(await allocateFreeKomodoOpenClawPort(serverId));
    }
    if (config.type === "moltis" && !config.env["MOLTIS_HOST_PORT"]) {
      config.env["MOLTIS_HOST_PORT"] = String(await allocateFreeKomodoMoltisPort(serverId));
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
    // OpenClaw validates browser origins for API/WebSocket access.
    // Allow the main Devlet origin, the direct host:port URL, and the
    // wildcard-subdomain proxy origin when that feature is configured.
    const openclawHostPort = config.env["OPENCLAW_HOST_PORT"];
    const agentHost = await resolveAccessHostForAgent(config.platform, config.id);
    const directOrigin = openclawHostPort ? `http://${agentHost}:${openclawHostPort}` : null;
    const allowedOrigins = [new URL(appConfig.publicBaseUrl).origin];
    const proxiedOriginUrl = await buildResolvedAgentSubdomainUrl(config, "openclaw");
    if (directOrigin) allowedOrigins.push(directOrigin);
    if (proxiedOriginUrl) allowedOrigins.push(new URL(proxiedOriginUrl).origin);
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

async function chooseRecoveryPlatform(
  state: AgentState,
  platformOverride?: PlatformTarget
): Promise<PlatformTarget> {
  if (platformOverride) return normalizePlatformTarget(platformOverride);

  const [dockerStatus, portainerStatus, proxmoxStatus, komodoStatus] = await Promise.all([
    probeDocker(),
    probePortainer(),
    probeProxmox(),
    // Recovery placement tolerates a ≤10 s cached Komodo snapshot; a hung
    // Komodo core must not block recovery indefinitely.
    probeKomodoCached(),
  ]);

  const portainer = portainerStatus.connected
    ? {
        ...portainerStatus,
        endpoints: portainerStatus.endpoints.map((endpoint) => ({
          ...endpoint,
          ...(state.config.platform.type === "portainer" &&
          endpoint.id === state.config.platform.endpointId
            ? { excluded: true }
            : {}),
        })),
      }
    : null;

  const decision = scheduleAgent(
    {
      type: state.config.type,
      resources: state.config.resources,
      persistent: state.config.persistent,
      onComplete: state.config.mission.onComplete,
      ...(state.config.gpu ? { gpu: state.config.gpu } : {}),
    },
    {
      docker: dockerStatus,
      portainer,
      proxmox: proxmoxStatus.connected ? proxmoxStatus : null,
      komodo: komodoStatus.connected ? komodoStatus : null,
    }
  );

  if (decision.outcome !== "scheduled" || !decision.placement) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: decision.summary,
    });
  }

  return normalizePlatformTarget(decision.placement);
}

export const appRouter = t.router({
  auth: t.router({
    // Lightweight session check for the web AuthGate: authentication middleware
    // only — zero platform probes, access discovery, or agent enumeration.
    session: authProcedure.query(() => ({ authenticated: true as const, serverTime: new Date().toISOString() })),
  }),

  agents: t.router({
    // List stays pure: file reads + env redaction only, no remote enrichment.
    // A slow/offline platform host cannot delay fleet data. Detail-level
    // access resolution (which may probe hosts) lives in `agents.get`.
    list: authProcedure.query(async () => {
      const started = Date.now();
      const states = await listAgentStates();
      const summarized = states.map(sanitizeAgentStateSummary);
      const elapsed = Date.now() - started;
      // Timing telemetry: counts and duration only — no agent names or mission content.
      console.log(`[agents.list] agents=${summarized.length} elapsedMs=${elapsed}`);
      return summarized;
    }),

    get: authProcedure.input(z.string()).query(async ({ input }) => {
      const started = Date.now();
      const enriched = await enrichAgentAccess(await loadAgentState(input));
      console.log(`[agents.get] elapsedMs=${Date.now() - started}`);
      return enriched;
    }),

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
        if (DISABLED_AGENT_TYPES.includes(input.type)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${AGENT_TYPE_LABELS[input.type]} is not available to hire right now`,
          });
        }
        const mins = AGENT_RESOURCE_MINS[input.type];
        if (input.resources.cpus < Math.ceil(mins.cpus)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${input.type} requires at least ${Math.ceil(mins.cpus)} CPU(s) (requested: ${input.resources.cpus})`,
          });
        }
        if (input.resources.memoryMb < mins.memoryMb) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${input.type} requires at least ${mins.memoryMb} MB RAM (requested: ${input.resources.memoryMb} MB)`,
          });
        }

        const [dockerStatus, portainerStatus, proxmoxStatus, komodoStatus] = await Promise.all([
          probeDocker(),
          probePortainer(),
          probeProxmox(),
          probeKomodo(),
        ]);
        const schedulerContext = {
          docker: dockerStatus,
          portainer: portainerStatus.connected ? portainerStatus : null,
          proxmox: proxmoxStatus.connected ? proxmoxStatus : null,
          komodo: komodoStatus.connected ? komodoStatus : null,
        };

        const platform =
          input.platformOverride ??
          (() => {
            const decision = scheduleAgent(
              {
                type: input.type,
                resources: normalizeResources(input.resources),
                persistent: input.persistent,
                onComplete: input.mission.onComplete,
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

        const platformMinimum = getResourceMinimum(input.type, platform);
        if (input.resources.memoryMb < platformMinimum.memoryMb) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Selected platform requires at least ${platformMinimum.memoryMb} MB RAM including the guest OS and Docker` });
        }
        const capacityError = resourceCapacityError(input.resources, getHostCapacity(platform, schedulerContext));
        if (capacityError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: capacityError });

        // Fail fast on Proxmox placements that cannot provision (missing
        // templates, offline node) instead of erroring asynchronously later.
        if (platform.type === "proxmox") {
          const placementCheck = await validateProxmoxPlacement(platform, proxmoxStatus, {
            gpuRequired: Boolean(input.gpu?.required),
            singleTask: input.mission.onComplete === "terminate",
          });
          if (!placementCheck.ok) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: placementCheck.message,
            });
          }
        }

        // GPU device selection only makes sense against a pinned host — with
        // auto-placement the scheduler picks the host, so devices can't be
        // known up front ("--gpus all" semantics apply there).
        const selectedGpuDevices = input.gpu?.devices ?? [];
        if (selectedGpuDevices.length > 0 && !input.platformOverride) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Selecting specific GPUs requires a pinned placement — choose a host in the wizard, then pick its GPUs",
          });
        }
        let gpuDevices = selectedGpuDevices;
        if (selectedGpuDevices.length > 0) {
          const hostDevices = resolveHostGpuDevices(platform, schedulerContext);
          if (!hostDevices.ok) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: hostDevices.message });
          }
          const deviceCheck = validateGpuDeviceIds(platform, selectedGpuDevices, hostDevices.devices);
          if (!deviceCheck.ok) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: deviceCheck.message });
          }
        } else if (input.gpu?.required) {
          // Selector left empty: assign one GPU — the least-claimed one — and
          // record it, instead of exposing every GPU of the host. Falls back
          // to "all" when the host's inventory is unknown.
          const hostDevices = resolveHostGpuDevices(platform, schedulerContext);
          if (hostDevices.ok) {
            const claims = countGpuClaims(await listAgentStates(), platform);
            const pick = pickDefaultGpuDevices(platform, hostDevices.devices, claims);
            if ("error" in pick) {
              throw new TRPCError({ code: "PRECONDITION_FAILED", message: pick.error });
            }
            gpuDevices = pick.devices;
          }
        }

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
          ...(input.gpu ? { gpu: normalizeGpu({ ...input.gpu, devices: gpuDevices }) } : {}),
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

        try {
          await admitAgent(state);
        } catch (error) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? error.message : "Disk admission failed" });
        }

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

        return sanitizeAgentStateSummary(state);
      }),

    fire: authProcedure.input(z.string()).mutation(async ({ input }) => {
      const state = await loadAgentState(input);
      await stopAgent(state.platformRef);
      await removeAgent(state.platformRef);
      // A hire that failed mid-provision has no platformRef — clean up any
      // partially created platform resources by name (Proxmox guests).
      if (state.platformRef === "pending") {
        await removeOrphanedProvision(state.config);
      }
      // Fire is a full teardown: also remove the agent's named volumes so its
      // workspace/home data is actually gone (not just the container).
      await removeAgentVolumes(state.platformRef, state.config.id).catch(() => {});
      await removeAgentDevices(state.config.id);
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
        // Delete is a full teardown: remove the agent's named volumes too.
        await removeAgentVolumes(state.platformRef, state.config.id).catch(() => {});
        await removeAgentDevices(state.config.id);
      } catch {
        // Non-fatal: proceed with state deletion regardless
      }
      await deleteAgentState(input);
    }),

    /**
     * Stop the agent in place. Non-destructive: the container and its named
     * volumes (workspace + home) are preserved, so `start` restores exactly
     * what was there. Sets status to `stopped` so the reconciler leaves it
     * alone (it is intentionally off, not crashed).
     */
    stop: authProcedure.input(z.string()).mutation(async ({ input }) => {
      const state = await loadAgentState(input);
      await stopAgent(state.platformRef);
      state.status = "stopped";
      delete state.error;
      state.logs.push("Agent stopped (data preserved)");
      await saveAgentState(state);
      return sanitizeAgentStateSummary(state);
    }),

    /**
     * Start a stopped agent in place. Non-destructive: brings back the existing
     * container and its preserved volumes. If the container is gone (e.g. the
     * platform was rebooted and dropped it), this falls back to re-provisioning
     * — which still reuses the named volumes, so data survives.
     */
    start: authProcedure.input(z.string()).mutation(async ({ input }) => {
      const state = await loadAgentState(input);
      try {
        await startAgent(state.platformRef);
      } catch {
        // Container missing — re-provision. Named volumes are reused, so the
        // agent's workspace/home data is preserved.
        const platformRef = await provisionAgent(state.config);
        state.platformRef = platformRef;
      }
      state.status = "running";
      delete state.error;
      state.config.lastActiveAt = new Date().toISOString();
      state.logs.push("Agent started (data preserved)");
      await saveAgentState(state);
      return sanitizeAgentStateSummary(state);
    }),

    /**
     * Non-destructive restart: stop then start the same container. Preserves
     * the container's writable layer AND its named volumes — nothing is lost.
     * Use this for "it's stuck, nudge it". Use `rebuild` to reset to a fresh
     * image (preserving only workspace/home via the named volumes).
     */
    restart: authProcedure.input(z.string()).mutation(async ({ input }) => {
      const state = await loadAgentState(input);
      await stopAgent(state.platformRef).catch(() => {});
      try {
        await startAgent(state.platformRef);
      } catch {
        // Container missing — re-provision (volumes reused, data preserved).
        const platformRef = await provisionAgent(state.config);
        state.platformRef = platformRef;
      }
      state.status = "running";
      delete state.error;
      state.config.lastActiveAt = new Date().toISOString();
      state.logs.push("Restart requested — stopped and started in place (data preserved)");
      await saveAgentState(state);
      return sanitizeAgentStateSummary(state);
    }),

    /**
     * Full rebuild: stop, remove the container, and re-provision from the image.
     * The agent's named volumes (workspace + home) are preserved, so project
     * files and tool configs survive — but everything else (the container's
     * writable layer, e.g. packages installed outside the manifest, /tmp, etc.)
     * resets to the image default. Use this to recover a broken agent state or
     * pick up a new image. Data in /workspace and /home/agent is NOT lost.
     *
     * Like `hire`, this returns immediately after flipping status to
     * `provisioning` and runs the rebuild asynchronously. The UI shows the
     * pulsing `provisioning` badge the moment the click lands (instead of
     * sitting on a stale `running` status for the whole re-provision), and the
     * status settles to `running`/`error` when the async work completes.
     */
    rebuild: authProcedure.input(z.string()).mutation(async ({ input }) => {
      const state = await loadAgentState(input);
      // Reflect the in-progress state up front so the UI has immediate feedback.
      state.status = "provisioning";
      state.logs.push("Rebuild requested — reprovisioning from image (workspace/home preserved)");
      await saveAgentState(state);

      // Run the rebuild asynchronously so this mutation returns immediately.
      (async () => {
        try {
          // Swallow stop/remove errors — container may already be gone.
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
          state.logs.push("Rebuild complete — running on fresh image");
          await saveAgentState(state);
        } catch (err: unknown) {
          state.status = "error";
          state.error = err instanceof Error ? err.message : String(err);
          state.logs.push(`Rebuild failed: ${state.error}`);
          await saveAgentState(state);
        }
      })();

      return sanitizeAgentStateSummary(state);
    }),

    recover: authProcedure
      .input(RecoverAgentInputSchema)
      .mutation(async ({ input }) => {
        const state = await loadAgentState(input.agentId);
        const oldPlatform = state.config.platform;
        const oldPlatformRef = state.platformRef;

        await stopAgent(state.platformRef).catch(() => {});
        await removeAgent(state.platformRef).catch(() => {});
        if (state.config.platform.type === "portainer") {
          await removePortainerContainerByName(
            state.config.platform.endpointId,
            `devlet-${state.config.id}`
          ).catch(() => {});
        }

        state.config.platform = await chooseRecoveryPlatform(state, input.platformOverride);
        await refreshAgentAccessPorts(state.config);

        const platformRef = await provisionAgent(state.config);
        state.platformRef = platformRef;
        state.status = "running";
        delete state.error;
        state.config.lastActiveAt = new Date().toISOString();
        state.logs.push(
          `Recovery requested — moved from ${oldPlatform.type}:${oldPlatformRef} to ${state.config.platform.type}:${platformRef}`
        );
        await saveAgentState(state);
        return sanitizeAgentStateSummary(state);
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
    diskCapacity: authProcedure
      .input(z.object({ platform: PlatformTargetSchema, gpuRequired: z.boolean().optional() }))
      .query(({ input }) => getDiskCapacity(normalizePlatformTarget(input.platform), undefined, input.gpuRequired)),
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

    tailscale: t.router({
      status: authProcedure.query(() => probeTailscale(isServerOnTailnet())),
    }),

    komodo: t.router({
      status: authProcedure.query(() => probeKomodoCached()),
      exclusions: authProcedure.query(() => loadEffectivePlatformExclusions()),
      setExcluded: authProcedure
        .input(SetKomodoExclusionInputSchema)
        .mutation(({ input }) => setKomodoExcluded(input.target, input.excluded)),
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
