import { exitDetails } from "./exit-details.js";
import { Types } from "komodo_client";
import type { AgentConfig } from "@devlet/shared";
import { agentImageFor } from "./docker.js";
import { gpuRunArg } from "./hardware.js";
import { buildContainerEnv } from "./env.js";
import { getKomodoClient, type Komodo } from "./komodo-client.js";
import { listAgentStates } from "../agents/state.js";
import { agentVolumeNames, agentVolumeMounts } from "./volumes.js";

/**
 * Komodo container lifecycle.
 *
 * Unlike Portainer (which proxies the raw Docker Engine API per endpoint),
 * Komodo deploys via its **Deployment** abstraction: create a named resource,
 * then `Deploy` it. A Deployment maps 1:1 onto an agent's provision/stop/remove.
 *
 * All behaviour here was verified live against Komodo v2.3.3 (see the probe
 * scripts under /tmp/komodo_test).
 */

// ─── Env serialization ────────────────────────────────────────────────────────
// Komodo's `environment` field is newline-separated KEY=VALUE (like a .env file).
// Values are interpolated through a shell during `docker run`, so backslash-escape
// the shell-special characters (`\ $ ` "`) to preserve them literally. Verified:
//   costs \$100 -> literal "$100"; \${HOME} -> literal "${HOME}".
function escapeKomodoEnvValue(value: string): string {
  return value.replace(/([\\$"`])/g, "\\$1");
}

/** Convert `buildContainerEnv` "KEY=VALUE" strings into Komodo's newline format. */
export function toKomodoEnvironment(envStrings: string[]): string {
  return envStrings
    .map((entry) => {
      const idx = entry.indexOf("=");
      if (idx === -1) return entry;
      return `${entry.slice(0, idx)}=${escapeKomodoEnvValue(entry.slice(idx + 1))}`;
    })
    .join("\n");
}

// ─── Port mappings ────────────────────────────────────────────────────────────
// Komodo uses bridge networking (default is `host`, which would bind fixed
// container ports directly and conflict across agents). With bridge + `-p`
// mappings we mirror Portainer exactly: variable host port -> fixed container port.
function buildPortMappings(agentConfig: AgentConfig): string {
  const pairs: string[] = [];
  const terminalPort = agentConfig.env["DEVLET_TERMINAL_PORT"];
  if (terminalPort) pairs.push(`${terminalPort}:${terminalPort}`);
  const sshPort = agentConfig.env["DEVLET_SSH_PORT"];
  if (sshPort) pairs.push(`${sshPort}:${sshPort}`);
  if (agentConfig.type === "openclaw") {
    const hostPort = agentConfig.env["OPENCLAW_HOST_PORT"] ?? "18789";
    pairs.push(`${hostPort}:18789`); // container gateway listens on fixed 18789
  }
  if (agentConfig.type === "moltis") {
    const hostPort = agentConfig.env["MOLTIS_HOST_PORT"] ?? "13131";
    pairs.push(`${hostPort}:13131`); // container gateway listens on fixed 13131
  }
  // Komodo expects one mapping per line; each becomes its own `-p` flag.
  return pairs.join("\n");
}

// ─── Port allocation ──────────────────────────────────────────────────────────
// Ports are published on the Komodo server's host, so "free" must be judged on
// that host, not on the machine running Devlet. A port is taken if any container
// there publishes it, or if a live Devlet agent already placed on the same server
// was assigned it (covers agents that are provisioning and not yet visible).
const AGENT_PORT_ENV_KEYS = [
  "DEVLET_TERMINAL_PORT",
  "DEVLET_SSH_PORT",
  "OPENCLAW_HOST_PORT",
  "MOLTIS_HOST_PORT",
] as const;

async function allocateFreeKomodoPort(serverId: string, start: number, end: number): Promise<number> {
  const used = new Set<number>();

  const containers = await client().read("ListContainers", { server: serverId });
  for (const container of containers) {
    for (const port of container.ports ?? []) {
      if (typeof port.PublicPort === "number") used.add(port.PublicPort);
    }
  }

  for (const state of await listAgentStates().catch(() => [])) {
    if (state.status === "terminated") continue;
    const platform = state.config.platform;
    if (platform.type !== "komodo" || platform.serverId !== serverId) continue;
    for (const key of AGENT_PORT_ENV_KEYS) {
      const value = Number(state.config.env[key]);
      if (Number.isInteger(value)) used.add(value);
    }
  }

  for (let port = start; port <= end; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`No free port available in range ${start}-${end} on Komodo server ${serverId}`);
}

export const allocateFreeKomodoTerminalPort = (serverId: string) => allocateFreeKomodoPort(serverId, 7681, 8681);
export const allocateFreeKomodoSshPort = (serverId: string) => allocateFreeKomodoPort(serverId, 2222, 3222);
export const allocateFreeKomodoOpenClawPort = (serverId: string) => allocateFreeKomodoPort(serverId, 18789, 19789);
export const allocateFreeKomodoMoltisPort = (serverId: string) => allocateFreeKomodoPort(serverId, 13131, 14131);

// ─── Extra `docker run` args (resources + GPU passthrough) ────────────────────
function buildExtraArgs(agentConfig: AgentConfig): string[] {
  const args: string[] = [];
  if (agentConfig.resources.cpus > 0) args.push("--cpus", String(agentConfig.resources.cpus));
  if (agentConfig.resources.memoryMb > 0) args.push("--memory", `${agentConfig.resources.memoryMb}m`);
  // Container GPU passthrough (not VM — that's Proxmox).
  if (agentConfig.gpu?.required && agentConfig.gpu.passthroughMode !== "vm") {
    args.push("--gpus", gpuRunArg(agentConfig.gpu.devices));
  }
  return args;
}

function client(): Komodo {
  const c = getKomodoClient();
  if (!c) throw new Error("Komodo is not configured (KOMODO_URL / KOMODO_API_KEY / KOMODO_API_SECRET)");
  return c;
}

/**
 * `execute_and_poll` resolves to either a single Update, an array of Updates,
 * or items that are `{ status: "Err" }`. Normalize to a success flag + detail.
 */
type RawUpdate = (Types.Update | { status: "Err"; data: unknown })[] | Types.Update;

function updateResult(raw: RawUpdate): { success: boolean; detail?: string } {
  const items = Array.isArray(raw) ? raw : [raw];
  const updates = items.filter((i): i is Types.Update => (i as Types.Update).success !== undefined);
  if (updates.length > 0) {
    if (updates.every((u) => u.success)) return { success: true };
    const detail = updates
      .flatMap((u) => u.logs ?? [])
      .map((l) => l.stderr || l.stdout)
      .filter(Boolean)
      .join(" | ")
      .slice(0, 400);
    return { success: false, detail };
  }
  const err = items.find((i): i is { status: "Err"; data: unknown } => (i as { status?: string }).status === "Err");
  if (err) return { success: false, detail: JSON.stringify(err.data).slice(0, 400) };
  return { success: false };
}

/** The Komodo Deployment name for an agent — globally unique, derived from the agent id. */
export function komodoDeploymentName(agentId: string): string {
  return `devlet-${agentId}`;
}

// ─── Deploy operations ────────────────────────────────────────────────────────

/**
 * Create + deploy an agent on the given Komodo server. Returns the platformRef
 * `komodo:{serverId}:{deploymentName}` for later lifecycle calls.
 */
export async function createKomodoContainer(agentConfig: AgentConfig, serverId: string): Promise<string> {
  const komodo = client();
  const name = komodoDeploymentName(agentConfig.id);

  // Idempotency: if a deployment with this name already exists, tear it down first.
  try {
    await komodo.read("GetDeployment", { deployment: name });
    await komodo.execute_and_poll("StopDeployment", { deployment: name }).catch(() => {});
    await komodo.execute_and_poll("DestroyDeployment", { deployment: name }).catch(() => {});
    await komodo.write("DeleteDeployment", { id: name }).catch(() => {});
  } catch {
    // Not present — nothing to clean up.
  }

  const env = toKomodoEnvironment(await buildContainerEnv(agentConfig));
  const ports = buildPortMappings(agentConfig);
  const extraArgs = buildExtraArgs(agentConfig);
  // Named volumes for persistence (workspace + home). Komodo's `volumes` field
  // is a newline-separated list of `source:target` mappings (like `ports`);
  // a bare name on the left is a named volume, which Docker auto-creates and
  // seeds with the image's initial content on first use.
  const volumes = agentVolumeMounts(agentConfig.id).join("\n");

  await komodo.write("CreateDeployment", {
    name,
    config: {
      server_id: serverId,
      image: { type: "Image", params: { image: agentImageFor(agentConfig) } },
      environment: env,
      network: "bridge",
      ...(ports ? { ports } : {}),
      ...(volumes ? { volumes } : {}),
      ...(extraArgs.length > 0 ? { extra_args: extraArgs } : {}),
      replicas: 1,
      termination_timeout: 10,
      send_alerts: false,
      restart: agentConfig.persistent ? Types.RestartMode.UnlessStopped : Types.RestartMode.NoRestart,
    },
  });

  const result = updateResult(await komodo.execute_and_poll("Deploy", { deployment: name }));
  if (!result.success) {
    await komodo.write("DeleteDeployment", { id: name }).catch(() => {});
    throw new Error(`Komodo deploy (${name}) failed${result.detail ? ` — ${result.detail}` : ""}`);
  }

  return `komodo:${serverId}:${name}`;
}

export async function stopKomodoContainer(_serverId: string, deploymentName: string): Promise<void> {
  const komodo = client();
  await komodo.execute_and_poll("StopDeployment", { deployment: deploymentName });
}

/** Start an existing (stopped) deployment in place — non-destructive. */
export async function startKomodoContainer(_serverId: string, deploymentName: string): Promise<void> {
  const komodo = client();
  await komodo.execute_and_poll("StartDeployment", { deployment: deploymentName });
}

/**
 * Remove the named volumes an agent owns (fire/delete only). Komodo exposes no
 * volume-create op, so volumes are created implicitly by the deployment's
 * `volumes` field; here we delete them explicitly. Best-effort per volume.
 */
export async function removeKomodoVolumes(serverId: string, agentId: string): Promise<void> {
  const komodo = client();
  for (const volumeName of agentVolumeNames(agentId)) {
    try {
      await komodo.execute("DeleteVolume", { server: serverId, name: volumeName });
    } catch {
      // Volume already gone — fine.
    }
  }
}

/** Destroy the running container and delete the Deployment resource. */
export async function removeKomodoContainer(_serverId: string, deploymentName: string): Promise<void> {
  const komodo = client();
  await komodo.execute_and_poll("DestroyDeployment", { deployment: deploymentName }).catch(() => {});
  await komodo.write("DeleteDeployment", { id: deploymentName });
}

/** Return the container's log lines (stdout), or [] if unavailable. */
export async function getKomodoContainerLogs(
  _serverId: string,
  deploymentName: string,
  tail = 200
): Promise<string[]> {
  const komodo = client();
  const log = await komodo.read("GetDeploymentLog", { deployment: deploymentName, tail });
  const text = typeof log === "string" ? log : [log?.stdout, log?.stderr].filter(Boolean).join("\n");
  return text.split("\n").filter((line) => line.length > 0);
}

/**
 * true if the deployment's container is running, false if it has exited OR the
 * deployment no longer exists (a missing runtime can be reprovisioned — same
 * semantics as Proxmox's 404→false), null if Komodo itself is unreachable.
 */
export async function getKomodoContainerRunning(
  _serverId: string,
  deploymentName: string
): Promise<boolean | null> {
  const komodo = client();
  try {
    const list = await komodo.read("ListDeployments", { query: {} });
    const found = list.find((d) => d.name === deploymentName);
    if (!found) return false;
    return found.info?.state === "running";
  } catch {
    return null;
  }
}

// ─── Orphan reconciliation ────────────────────────────────────────────────────
// A deployment is "orphaned" when its name matches the `devlet-agent-*` pattern
// but no agent state references it — either by config.id or by platformRef. This
// happens when an agent is terminated/failed without its Komodo cleanup running to
// completion, or when the server that created it lost its state. The reconciler
// tears these down so they don't linger as unmanaged, self-restarting containers.

/**
 * Pure orphan filter: given Komodo deployment names and the agent states a server
 * owns, return the deployment names that match the `devlet-agent-*` convention but
 * are referenced by no agent (by config.id or by platformRef). Exported for tests.
 */
export function filterOrphanedKomodoDeployments(
  deploymentNames: string[],
  states: { config: { id: string }; platformRef: string }[]
): string[] {
  const known = new Set<string>();
  for (const s of states) {
    // The deployment an agent uses is `devlet-${config.id}` (komodoDeploymentName).
    // Add it directly so an agent still provisioning (platformRef not yet persisted
    // but its deployment already created) is never mistaken for an orphan.
    known.add(`devlet-${s.config.id}`);
    if (s.platformRef.startsWith("komodo:")) {
      const name = s.platformRef.split(":")[2];
      if (name) known.add(name);
    }
  }
  return deploymentNames.filter((name) => name.startsWith("devlet-agent-") && !known.has(name));
}

/**
 * List `devlet-agent-*` deployments that have no matching agent state.
 * Returns `[]` (rather than throwing) when Komodo is unreachable, so callers can
 * treat "not configured / offline" as "nothing to reconcile".
 */
export async function listOrphanedKomodoDeployments(): Promise<string[]> {
  const komodo = getKomodoClient();
  if (!komodo) return [];

  const states = await listAgentStates().catch(() => []);
  try {
    const list = await komodo.read("ListDeployments", { query: {} });
    return filterOrphanedKomodoDeployments(
      list.map((d) => d.name),
      states
    );
  } catch {
    return [];
  }
}

/** Best-effort log capture for an orphan before it is destroyed. */
export async function getOrphanedKomodoDeploymentLog(deploymentName: string): Promise<string[]> {
  try {
    return await getKomodoContainerLogs("", deploymentName);
  } catch {
    return [];
  }
}

/**
 * Tear down a single orphaned deployment: stop, destroy the container, delete the
 * Deployment resource, and drop any stale tailnet node. Best-effort throughout —
 * an already-gone deployment is a success.
 */
export async function removeOrphanedKomodoDeployment(deploymentName: string): Promise<void> {
  const komodo = client();
  await komodo.execute_and_poll("StopDeployment", { deployment: deploymentName }).catch(() => {});
  await removeKomodoContainer("", deploymentName);
  // Deployment names are `devlet-agent-<id>`; the tailnet hostname is `devlet-<id>`.
  const agentId = deploymentName.replace(/^devlet-/, "");
  try {
    const { removeDevicesByHostname } = await import("../tailscale/client.js");
    const { config } = await import("../config.js");
    await removeDevicesByHostname(`devlet-${agentId}`, config.tailscale.tag);
  } catch {
    // Tailscale not configured / offline — nothing to clean up.
  }
}

export async function getKomodoExitDetails(server: string, container: string) {
  return exitDetails((await client().read("InspectContainer", { server, container })).State);
}
