import type { AgentConfig } from "@devlet/shared";
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

// ─── platformRef format ───────────────────────────────────────────────────────
//   pending                           — not yet provisioned
//   container:{id}                    — local Docker
//   portainer:{endpointId}:{id}       — Portainer-managed Docker endpoint
//   proxmox:{node}:{vmType}:{vmId}    — Proxmox LXC or QEMU

type ParsedRef =
  | { type: "pending" }
  | { type: "docker"; containerId: string }
  | { type: "portainer"; endpointId: number; containerId: string }
  | { type: "proxmox"; node: string; vmType: "lxc" | "qemu"; vmId: string };

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

  // Legacy bare container ID
  return { type: "docker", containerId: ref };
}

// ─── Dispatch operations ──────────────────────────────────────────────────────

/**
 * Provision an agent on whichever platform `config.platform` specifies.
 * Returns the full platformRef string for the created resource.
 */
export async function provisionAgent(config: AgentConfig): Promise<string> {
  switch (config.platform.type) {
    case "docker": {
      const id = await createAgentContainer(config);
      return `container:${id}`;
    }

    case "portainer": {
      return createPortainerContainer(config, config.platform.endpointId);
    }

    case "proxmox": {
      // TODO: implemented by Codex — see tasks/codex/004-proxmox-deploy.md
      throw new Error(
        `Proxmox provisioning not yet implemented (node: ${config.platform.node}, type: ${config.platform.vmType})`
      );
    }
  }
}

export async function stopAgent(platformRef: string): Promise<void> {
  const parsed = parsePlatformRef(platformRef);
  if (parsed.type === "pending") return;
  if (parsed.type === "docker") return stopContainer(parsed.containerId);
  if (parsed.type === "portainer") return stopPortainerContainer(parsed.endpointId, parsed.containerId);
  if (parsed.type === "proxmox") {
    throw new Error(`Proxmox stop not yet implemented`);
  }
}

export async function removeAgent(platformRef: string): Promise<void> {
  const parsed = parsePlatformRef(platformRef);
  if (parsed.type === "pending") return;
  if (parsed.type === "docker") return removeContainer(parsed.containerId);
  if (parsed.type === "portainer") return removePortainerContainer(parsed.endpointId, parsed.containerId);
  if (parsed.type === "proxmox") {
    throw new Error(`Proxmox remove not yet implemented`);
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
  return null; // proxmox — not yet implemented
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
  if (parsed.type === "proxmox") return fallback;
  return fallback;
}
