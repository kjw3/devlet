/**
 * Hire-time validation for selected GPU devices (the hire wizard's GPU
 * selector). The selector offers `GpuDeviceInfo[]` from each platform's status
 * probe; this module re-checks the selection against the resolved placement
 * right before deployment, so a stale UI or racing API cannot attach a GPU
 * that is gone, non-existent, or already claimed.
 *
 * Semantics per platform:
 * - Docker/Portainer/Komodo: ids are NVIDIA GPU UUIDs from `nvidia-smi -L`
 *   (Komodo) or Docker GenericResources / snapshot data. Uniqueness is not
 *   enforced — two containers may share a GPU.
 * - Proxmox: ids are PCI ids. `busy` is authoritative (hostpci passthrough is
 *   exclusive), so a GPU passed to another VM fails validation.
 */
import type { AgentConfig, AgentStatus, GpuDeviceInfo, PlatformTarget } from "@devlet/shared";
import type { DockerStatus, KomodoStatus, PortainerStatus, ProxmoxStatus } from "@devlet/shared";

export interface GpuDeviceValidation {
  ok: boolean;
  message?: string;
}

/** Why the placement could not be resolved to a device list. */
export interface ResolvedHostDevices {
  ok: boolean;
  message?: string;
  devices: GpuDeviceInfo[];
}

export interface SchedulerStatuses {
  docker: DockerStatus | null;
  portainer: PortainerStatus | null;
  proxmox: ProxmoxStatus | null;
  komodo: KomodoStatus | null;
}

function platformLabel(platform: PlatformTarget): string {
  switch (platform.type) {
    case "docker":
      return "the Docker host";
    case "portainer":
      return `Portainer endpoint ${platform.endpointId}`;
    case "proxmox":
      return `Proxmox node ${platform.node}`;
    case "komodo":
      return `Komodo server ${platform.serverId}`;
  }
}

/** Pure check of requested device ids against a host's GPU inventory. */
export function validateGpuDeviceIds(
  platform: PlatformTarget,
  requested: string[],
  available: GpuDeviceInfo[]
): GpuDeviceValidation {
  if (requested.length === 0) return { ok: true };

  const missing = requested.filter((id) => !available.some((a) => a.id === id));
  if (missing.length > 0) {
    const known = available.map((a) => `${shortDeviceId(a.id)}${a.model ? ` (${a.model})` : ""}`);
    return {
      ok: false,
      message:
        `GPU device(s) not available on ${platformLabel(platform)}: ${missing.map(shortDeviceId).join(", ")}. ` +
        `Available: ${known.length ? known.join(", ") : "none"}.`,
    };
  }

  const busy = requested.filter((id) => available.find((a) => a.id === id)?.busy);
  if (busy.length > 0) {
    return {
      ok: false,
      message:
        `GPU device(s) on ${platformLabel(platform)} are already passed through to another VM: ` +
        `${busy.map(shortDeviceId).join(", ")}.`,
    };
  }

  return { ok: true };
}

/** Inventory for the resolved placement, from the probe data captured at hire time. */
export function resolveHostGpuDevices(platform: PlatformTarget, statuses: SchedulerStatuses): ResolvedHostDevices {
  const none: ResolvedHostDevices = { ok: false, devices: [] };
  switch (platform.type) {
    case "docker": {
      if (!statuses.docker?.connected) return { ...none, message: "Docker host is not connected" };
      return { ok: true, devices: statuses.docker.gpuDevices ?? [] };
    }
    case "portainer": {
      const endpoint = statuses.portainer?.endpoints.find((e) => e.id === platform.endpointId);
      if (!endpoint) return { ...none, message: `Portainer endpoint ${platform.endpointId} not found` };
      return { ok: true, devices: endpoint.gpuDevices ?? [] };
    }
    case "proxmox": {
      const node = statuses.proxmox?.nodes.find((n) => n.name === platform.node);
      if (!node || node.status !== "online") return { ...none, message: `Proxmox node ${platform.node} is not online` };
      return { ok: true, devices: node.gpuDevices ?? [] };
    }
    case "komodo": {
      const server = statuses.komodo?.servers.find((s) => s.id === platform.serverId || s.name === platform.serverId);
      if (!server || server.state !== "ok") return { ...none, message: `Komodo server ${platform.serverId} is not online` };
      return { ok: true, devices: server.gpuDevices ?? [] };
    }
  }
}

/** Shorten GPU-UUID / PCI ids for error messages. */
function shortDeviceId(id: string): string {
  if (id.startsWith("GPU-")) return id.slice(4, 16);
  return id;
}

// ─── Default assignment (selector left empty) ─────────────────────────────────

/** How many active agents have claimed each GPU on this host. */
export function countGpuClaims(
  states: Array<{ config: Pick<AgentConfig, "platform" | "gpu">; status: AgentStatus }>,
  platform: PlatformTarget
): Map<string, number> {
  const claims = new Map<string, number>();
  const hostKey = (p: PlatformTarget): string => {
    switch (p.type) {
      case "docker":
        return "docker";
      case "portainer":
        return `portainer:${p.endpointId}`;
      case "proxmox":
        return `proxmox:${p.node}`;
      case "komodo":
        return `komodo:${p.serverId}`;
    }
  };
  for (const s of states) {
    if (s.status === "terminated" || s.status === "error") continue;
    if (s.config.platform.type !== platform.type) continue;
    if (hostKey(s.config.platform) !== hostKey(platform)) continue;
    for (const d of s.config.gpu?.devices ?? []) {
      claims.set(d, (claims.get(d) ?? 0) + 1);
    }
  }
  return claims;
}

/**
 * GPU assignment when the wizard's selector is left empty: one GPU — the
 * least-claimed one — recorded in the config, instead of blanket "all GPUs".
 * Container platforms share GPUs, so contention never fails; Proxmox
 * passthrough is exclusive, so a node whose every GPU is already claimed
 * fails here (at hire time) instead of at VM start. Empty inventory (probe
 * failed, unknown host) falls back to the legacy "all" behaviour.
 */
export function pickDefaultGpuDevices(
  platform: PlatformTarget,
  available: GpuDeviceInfo[],
  claims: Map<string, number>
): { devices: string[] } | { error: string } {
  if (available.length === 0) return { devices: [] };
  const free = available.filter((d) => !d.busy);
  if (platform.type === "proxmox" && free.length === 0) {
    return {
      error: `All GPUs on node ${platform.node} are already passed through to other VMs`,
    };
  }
  const pool = free.length > 0 ? free : available;
  const picked = [...pool].sort((a, b) => (claims.get(a.id) ?? 0) - (claims.get(b.id) ?? 0))[0]!;
  return { devices: [picked.id] };
}
