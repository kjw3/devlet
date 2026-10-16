import { agentDiskMaximumGb, diskMaximumGb, diskSizeError, templateDiskGb, type DiskCapacity, type PlatformTarget } from "@devlet/shared";
import { config } from "../config.js";
import { listAgentStates } from "../agents/state.js";
import { getStorageInfo, pveGet } from "./proxmox-client.js";

async function storageTarget(target: PlatformTarget, gpuRequired?: boolean) {
  if (target.type !== "proxmox") throw new Error("Disk quotas are not supported on this target");
  let storage = config.proxmox.storage;
  let minimumGb = 10;
  if (target.vmType === "qemu") {
    // GPU hires pull the ~8.5 GB devlet-agent-gpu image (pull+unpack peaks
    // ~13 GB in /var/lib/docker), so their floor is 32 GB, not the plain 20.
    const floor = gpuRequired ? 32 : 20;
    const { findTemplateNode, resolveQemuCloneStorage } = await import("./proxmox-deploy.js");
    const node = await findTemplateNode(config.proxmox.qemuTemplateId);
    if (!node) throw new Error("QEMU template is unavailable");
    storage = (await resolveQemuCloneStorage(node, target.node)).storage;
    const template = await pveGet<Record<string, unknown>>(`/nodes/${encodeURIComponent(node)}/qemu/${config.proxmox.qemuTemplateId}/config`);
    minimumGb = Math.max(floor, templateDiskGb(template));
  }
  const info = await getStorageInfo(target.node, storage);
  if (!info) throw new Error("Storage metadata is unavailable");
  return { storage, minimumGb, poolKey: info.shared ? `shared:${storage}` : `${target.node}:${storage}` };
}

export async function getDiskCapacity(target: PlatformTarget, excludeAgentId?: string, gpuRequired?: boolean): Promise<DiskCapacity> {
  const policyMaximumGb = agentDiskMaximumGb(process.env["DEVLET_AGENT_DISK_MAX_GB"]);
  if (target.type !== "proxmox") return { supported: false, minimumGb: 10, policyMaximumGb, reason: "Disk limits unavailable: this Docker backend has no verified quota configuration. Shared image layers and writable storage use host space." };
  const fallbackMinimumGb = target.vmType === "qemu" ? (gpuRequired ? 32 : 20) : 10;
  try {
    const selected = await storageTarget(target, gpuRequired);
    const status = await pveGet<{ avail?: number; active?: number; enabled?: number }>(`/nodes/${encodeURIComponent(target.node)}/storage/${encodeURIComponent(selected.storage)}/status`);
    if (status.active === 0 || status.enabled === 0 || !Number.isFinite(status.avail) || status.avail! < 0) throw new Error("Storage is inactive or free space is unknown");
    const reserveGb = Number(process.env["DEVLET_DISK_RESERVE_GB"] ?? 10);
    if (!Number.isFinite(reserveGb) || reserveGb < 0) throw new Error("Invalid DEVLET_DISK_RESERVE_GB");
    let pendingGb = 0;
    // Persisted provisioning states survive server restarts. Reserving the full
    // virtual size is conservative for thin/linked clones, not a physical guarantee.
    for (const state of await listAgentStates()) {
      if (state.config.id === excludeAgentId || state.status !== "provisioning" || state.config.platform.type !== "proxmox") continue;
      const pending = await storageTarget(state.config.platform);
      if (pending.poolKey === selected.poolKey) pendingGb += (state.config.resources.storageMb ?? pending.minimumGb * 1024) / 1024;
    }
    return { supported: true, ...selected, availableGb: Math.floor(status.avail! / 1024 ** 3), reserveGb, policyMaximumGb, maximumGb: diskMaximumGb(status.avail!, reserveGb, pendingGb, policyMaximumGb) };
  } catch (error) {
    return { supported: true, minimumGb: fallbackMinimumGb, policyMaximumGb, reason: error instanceof Error ? error.message : "Disk capacity unavailable" };
  }
}

export async function validateDisk(target: PlatformTarget, storageMb?: number, excludeAgentId?: string, gpuRequired?: boolean): Promise<number | undefined> {
  if (target.type !== "proxmox" && storageMb === undefined) return undefined;
  const capacity = await getDiskCapacity(target, excludeAgentId, gpuRequired);
  const gb = storageMb === undefined ? capacity.minimumGb : storageMb / 1024;
  const error = diskSizeError(gb, capacity);
  if (error) throw new Error(error);
  return gb * 1024;
}
