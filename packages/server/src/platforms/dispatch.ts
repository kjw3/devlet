import type { AgentConfig } from "@devlet/shared";
import { withTailscaleEnv } from "../tailscale/client.js";
import {
  createAgentContainer,
  getContainerLogs,
  getContainerRunning,
  removeContainer,
  stopContainer,
} from "./docker.js";
import {
  createPortainerContainer,
  getPortainerContainerLogs,
  getPortainerContainerRunning,
  removePortainerContainer,
  stopPortainerContainer,
} from "./portainer-deploy.js";
import {
  createKomodoContainer,
  getKomodoContainerLogs,
  getKomodoContainerRunning,
  removeKomodoContainer,
  stopKomodoContainer,
} from "./komodo-deploy.js";
import {
  createProxmoxGuest,
  getProxmoxGuestLogs,
  getProxmoxGuestRunning,
  removeProxmoxGuest,
  stopProxmoxGuest,
} from "./proxmox-deploy.js";
import { allocateVmid } from "./proxmox-client.js";

// ─── platformRef format ───────────────────────────────────────────────────────
//   pending                           — not yet provisioned
//   container:{id}                    — local Docker
//   portainer:{endpointId}:{id}       — Portainer-managed Docker endpoint
//   proxmox:{node}:{vmType}:{vmId}    — Proxmox LXC or QEMU
//   komodo:{serverId}:{deploymentName} — Komodo-managed Deployment

type ParsedRef =
  | { type: "pending" }
  | { type: "docker"; containerId: string }
  | { type: "portainer"; endpointId: number; containerId: string }
  | { type: "proxmox"; node: string; vmType: "lxc" | "qemu"; vmId: string }
  | { type: "komodo"; serverId: string; deploymentName: string };

function parsePlatformRef(ref: string): ParsedRef {
  if (ref === "pending") return { type: "pending" };

  if (ref.startsWith("container:")) {
    return { type: "docker", containerId: ref.slice("container:".length) };
  }

  if (ref.startsWith("portainer:")) {
    const [, endpointId, containerId] = ref.split(":");
    return { type: "portainer", endpointId: Number(endpointId), containerId: containerId! };
  }

  if (ref.startsWith("proxmox:")) {
    const [, node, vmType, vmId] = ref.split(":");
    return {
      type: "proxmox",
      node: node!,
      vmType: vmType as "lxc" | "qemu",
      vmId: vmId!,
    };
  }

  if (ref.startsWith("komodo:")) {
    const [, serverId, deploymentName] = ref.split(":");
    return { type: "komodo", serverId: serverId!, deploymentName: deploymentName! };
  }

  // Legacy bare container ID
  return { type: "docker", containerId: ref };
}

// ─── Dispatch operations ──────────────────────────────────────────────────────

/**
 * Provision an agent on whichever platform `config.platform` specifies.
 * Returns the full platformRef string for the created resource.
 */
export async function provisionAgent(baseConfig: AgentConfig): Promise<string> {
  // Per-launch tailnet env (single-use auth key) — not persisted in saved agent state.
  const config = await withTailscaleEnv(baseConfig);
  switch (config.platform.type) {
    case "docker": {
      const id = await createAgentContainer(config);
      return `container:${id}`;
    }

    case "portainer": {
      return createPortainerContainer(config, config.platform.endpointId);
    }

    case "proxmox": {
      // Deploy via the PVE API — LXC for CPU agents, QEMU clone for GPU/VM
      // agents (docs/proxmox-provisioning.md).
      const platform = config.platform;
      if (platform.type !== "proxmox") {
        throw new Error("Proxmox provisioning invoked without a proxmox platform target");
      }
      return createProxmoxGuest(config);
    }

    case "komodo": {
      return createKomodoContainer(config, config.platform.serverId);
    }
  }
}

export async function stopAgent(platformRef: string): Promise<void> {
  const parsed = parsePlatformRef(platformRef);
  if (parsed.type === "pending") return;
  if (parsed.type === "docker") return stopContainer(parsed.containerId);
  if (parsed.type === "portainer") return stopPortainerContainer(parsed.endpointId, parsed.containerId);
  if (parsed.type === "komodo") return stopKomodoContainer(parsed.serverId, parsed.deploymentName);
  if (parsed.type === "proxmox") {
    return stopProxmoxGuest(parsed.node, parsed.vmType, Number(parsed.vmId));
  }
}

export async function removeAgent(platformRef: string): Promise<void> {
  const parsed = parsePlatformRef(platformRef);
  if (parsed.type === "pending") return;
  if (parsed.type === "docker") return removeContainer(parsed.containerId);
  if (parsed.type === "portainer") return removePortainerContainer(parsed.endpointId, parsed.containerId);
  if (parsed.type === "komodo") return removeKomodoContainer(parsed.serverId, parsed.deploymentName);
  if (parsed.type === "proxmox") {
    return removeProxmoxGuest(parsed.node, parsed.vmType, Number(parsed.vmId));
  }
}

/**
 * Best-effort teardown for hires that failed before a platformRef was
 * persisted. Proxmox guests are named deterministically (devlet-{agentId},
 * D3), so an orphaned guest from a partial provision can still be found and
 * destroyed. Other platforms are skipped — nothing recoverable by name.
 */
export async function removeOrphanedProvision(config: AgentConfig): Promise<void> {
  if (config.platform.type !== "proxmox") return;
  try {
    const allocation = await allocateVmid(config.id);
    if (!allocation.existingGuest) return;
    const { node, vmType, vmid } = allocation.existingGuest;
    await removeProxmoxGuest(node, vmType, Number(vmid));
  } catch {
    // best effort — the reconciler/state shows the failure otherwise
  }
}

/**
 * Returns true if the agent's container/VM is still running,
 * false if it has exited, or null if status cannot be determined
 * (pending, proxmox, or an unreachable endpoint).
 */
export async function getAgentRunning(platformRef: string): Promise<boolean | null> {
  const parsed = parsePlatformRef(platformRef);
  if (parsed.type === "pending") return null;
  if (parsed.type === "docker") return getContainerRunning(parsed.containerId);
  if (parsed.type === "portainer") return getPortainerContainerRunning(parsed.endpointId, parsed.containerId);
  if (parsed.type === "komodo") return getKomodoContainerRunning(parsed.serverId, parsed.deploymentName);
  if (parsed.type === "proxmox") {
    return getProxmoxGuestRunning(parsed.node, parsed.vmType, Number(parsed.vmId));
  }
  return null;
}

export async function getAgentLogs(
  platformRef: string,
  fallback: string[]
): Promise<string[]> {
  const parsed = parsePlatformRef(platformRef);
  if (parsed.type === "pending") return fallback;
  if (parsed.type === "docker") {
    try {
      return await getContainerLogs(parsed.containerId);
    } catch {
      return fallback; // container already removed
    }
  }
  if (parsed.type === "portainer") {
    try {
      return await getPortainerContainerLogs(parsed.endpointId, parsed.containerId);
    } catch {
      return fallback;
    }
  }
  if (parsed.type === "komodo") {
    try {
      return await getKomodoContainerLogs(parsed.serverId, parsed.deploymentName);
    } catch {
      return fallback;
    }
  }
  if (parsed.type === "proxmox") {
    try {
      const logs = await getProxmoxGuestLogs(parsed.node, parsed.vmType, Number(parsed.vmId));
      return logs.length > 0 ? logs : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}
