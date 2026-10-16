import type { ProxmoxStatus } from "@devlet/shared";
import { config } from "../config.js";
import { loadEffectivePlatformExclusions } from "./exclusions.js";
import {
  authHeaders,
  countGpuDevices,
  isProxmoxConfigured,
  listClusterGuests,
  listStorageContent,
  pveGet,
  pickGpuPciId,
} from "./proxmox-client.js";

interface ProxmoxApiVersion {
  version: string;
}

interface ProxmoxApiNode {
  node: string;
  status: string;
  cpu: number;
  mem: number;
  maxmem: number;
}

interface ProxmoxApiNodeStatus {
  cpuinfo?: {
    arch?: string;
    flags?: string;
    model?: string;
  };
  arch?: string;
}

function normalizeArchitecture(value: string | undefined): "amd64" | "arm64" | "unknown" {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "amd64" || normalized === "x86_64") return "amd64";
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  return "unknown";
}

/** PVE 9.x omits `arch` from /nodes/{node}/status on many setups — infer the
 *  architecture from cpuinfo: x86_64 CPUs report the "lm" (long mode) flag,
 *  aarch64 CPUs report "asimd". */
export function inferNodeArchitecture(status: ProxmoxApiNodeStatus): "amd64" | "arm64" | "unknown" {
  const direct = normalizeArchitecture(status.arch ?? status.cpuinfo?.arch);
  if (direct !== "unknown") return direct;
  const flags = (status.cpuinfo?.flags ?? "").split(/\s+/);
  if (flags.includes("lm")) return "amd64";
  if (flags.includes("asimd") || (status.cpuinfo?.model ?? "").toLowerCase().includes("aarch64")) {
    return "arm64";
  }
  return "unknown";
}

export async function probeProxmox(): Promise<ProxmoxStatus> {
  if (!isProxmoxConfigured() || !authHeaders()) {
    return {
      connected: false,
      configured: false,
      nodes: [],
      error: "Proxmox credentials not configured (PROXMOX_URL, PROXMOX_USER, PROXMOX_TOKEN_ID, PROXMOX_TOKEN_SECRET)",
    };
  }

  try {
    const [versionData, nodesData] = await Promise.all([
      pveGet<ProxmoxApiVersion>(`/version`),
      pveGet<ProxmoxApiNode[]>(`/nodes`),
    ]);

    const exclusions = await loadEffectivePlatformExclusions();
    const nodeArchitectures = new Map<string, "amd64" | "arm64" | "unknown">();
    const nodeGpuCounts = new Map<string, number>();

    await Promise.all(
      nodesData.map(async (node) => {
        try {
          const [status, gpuCount] = await Promise.all([
            pveGet<ProxmoxApiNodeStatus>(`/nodes/${encodeURIComponent(node.node)}/status`),
            countGpuDevices(node.node),
          ]);
          nodeArchitectures.set(node.node, inferNodeArchitecture(status));
          nodeGpuCounts.set(node.node, gpuCount);
        } catch {
          nodeArchitectures.set(node.node, "unknown");
        }
      })
    );

    const status: ProxmoxStatus = {
      connected: true,
      version: versionData.version,
      nodes: nodesData.map((n) => ({
        name: n.node,
        status: n.status === "online" ? "online" : n.status === "offline" ? "offline" : "unknown",
        cpuUsage: n.cpu,
        memoryUsed: Math.round(n.mem / 1024 / 1024),
        memoryTotal: Math.round(n.maxmem / 1024 / 1024),
        architecture: nodeArchitectures.get(n.node) ?? "unknown",
        gpuCount: nodeGpuCounts.get(n.node) ?? 0,
        ...(exclusions.proxmoxNodes.includes(n.node) ? { excluded: true } : {}),
      })),
      // Provisioning readiness (docs/proxmox-provisioning.md)
      defaultNode: config.proxmox.node,
      storage: config.proxmox.storage,
      lxcTemplate: config.proxmox.lxcTemplate,
      qemuTemplateId: config.proxmox.qemuTemplateId,
    };

    // Template readiness is node/storage-specific; check against the default
    // node. Hire-time validation re-checks the actually selected node.
    const readinessNode = config.proxmox.node || nodesData.find((n) => n.status === "online")?.node || "";
    if (readinessNode) {
      const [lxcReady, qemuReady] = await Promise.all([
        checkLxcTemplate(readinessNode),
        checkQemuTemplate(),
      ]);
      status.lxcTemplateReady = lxcReady;
      status.qemuTemplateReady = qemuReady;

      const blocker = readinessBlocker(status);
      if (blocker) status.provisioningBlocker = blocker;
    }

    return status;
  } catch (err) {
    return {
      connected: false,
      nodes: [],
      error: String(err),
    };
  }
}

async function checkLxcTemplate(node: string): Promise<boolean> {
  if (!config.proxmox.lxcTemplate) return false;
  try {
    // The volid names its own storage ("ceph-fs:vztmpl/…"); PROXMOX_STORAGE is
    // only where guest disks go. Templates may live on any (shared) storage.
    const storage = config.proxmox.lxcTemplate.split(":")[0] || config.proxmox.storage;
    const entries = await listStorageContent(node, storage, "vztmpl");
    return entries.some((e) => e.volid === config.proxmox.lxcTemplate);
  } catch {
    return false;
  }
}

async function checkQemuTemplate(): Promise<boolean> {
  const id = config.proxmox.qemuTemplateId;
  if (!id) return false;
  try {
    const guests = await listClusterGuests();
    return guests.some((g) => g.vmid === id && g.template === 1);
  } catch {
    return false;
  }
}

function readinessBlocker(status: ProxmoxStatus): string | undefined {
  const parts: string[] = [];
  if (!status.lxcTemplate) {
    parts.push("PROXMOX_LXC_TEMPLATE is not set (required for LXC agents)");
  } else if (status.lxcTemplateReady === false) {
    parts.push(`LXC template "${status.lxcTemplate}" not found in storage "${status.storage}"`);
  }
  if (!status.qemuTemplateId) {
    parts.push("PROXMOX_QEMU_TEMPLATE_ID is not set (required for VM/GPU agents)");
  } else if (status.qemuTemplateReady === false) {
    parts.push(`QEMU template VM ${status.qemuTemplateId} not found in the cluster`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

export {
  checkLxcTemplate,
  checkQemuTemplate,
  readinessBlocker,
};

// ─── Hire-time placement validation (D8) ────────────────────────────────────────
// The scheduler (or a placement override) can hand us a proxmox target; verify
// the chosen node can actually provision it before the hire is accepted, so
// failures happen synchronously with a clear message instead of asynchronously
// in the provisioner.

export async function validateProxmoxPlacement(
  target: { type: string; node?: string; vmType?: string },
  status: ProxmoxStatus,
  opts?: { gpuRequired?: boolean; singleTask?: boolean }
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (target.type !== "proxmox") return { ok: true };

  if (!status.connected) {
    return { ok: false, message: `Proxmox API not reachable: ${status.error ?? "unknown error"}` };
  }

  const node = target.node || status.defaultNode || "";
  if (!node) {
    return { ok: false, message: "No Proxmox node selected and PROXMOX_NODE is not set" };
  }

  const nodeInfo = status.nodes.find((n) => n.name === node);
  if (!nodeInfo) {
    return { ok: false, message: `Proxmox node "${node}" does not exist in the cluster` };
  }
  if (nodeInfo.status !== "online") {
    return { ok: false, message: `Proxmox node "${node}" is ${nodeInfo.status}` };
  }

  if (nodeInfo.excluded) return { ok: false, message: `Proxmox node "${node}" is excluded` };
  const vmType = target.vmType === "qemu" ? "qemu" : "lxc";
  if (opts?.singleTask && vmType !== "lxc") {
    return { ok: false, message: "Single-task Proxmox agents must use LXC" };
  }
  if (opts?.gpuRequired && vmType !== "qemu") {
    return { ok: false, message: "Proxmox GPU passthrough requires a VM, not LXC" };
  }
  if (vmType === "lxc") {
    if (!config.proxmox.lxcTemplate) {
      return {
        ok: false,
        message: "LXC placement requires PROXMOX_LXC_TEMPLATE (e.g. local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst)",
      };
    }
    // Probe status only checks the default node; re-check the selected node
    // (results are cached briefly since the same template is usually reused).
    const exists = await cachedTemplateCheck(`lxc:${node}:${config.proxmox.lxcTemplate}`, () =>
      checkLxcTemplate(node)
    );
    if (!exists) {
      return {
        ok: false,
        message: `LXC template "${config.proxmox.lxcTemplate}" not found on node "${node}" (storage "${config.proxmox.storage}")`,
      };
    }
  } else {
    if (!config.proxmox.qemuTemplateId) {
      return {
        ok: false,
        message: "VM placement requires PROXMOX_QEMU_TEMPLATE_ID (a template VM to full-clone)",
      };
    }
    const exists = await cachedTemplateCheck(`qemu:${config.proxmox.qemuTemplateId}`, () =>
      checkQemuTemplate()
    );
    if (!exists) {
      return {
        ok: false,
        message: `QEMU template VM ${config.proxmox.qemuTemplateId} not found in the cluster`,
      };
    }
    // GPU precheck (D8): reject synchronously when every GPU on the node is
    // already passed through to another VM, instead of failing after a clone.
    if (opts?.gpuRequired) {
      const picked = await pickGpuPciId(node);
      if (!picked) {
        return {
          ok: false,
          message:
            `Node "${node}" has no free GPU for passthrough ` +
            "(all detected GPUs are already assigned to other VMs, or none is present)",
        };
      }
    }
  }

  return { ok: true };
}

const TEMPLATE_CHECK_TTL_MS = 60_000;
const templateCheckCache = new Map<string, { at: number; result: boolean }>();

async function cachedTemplateCheck(key: string, check: () => Promise<boolean>): Promise<boolean> {
  const cached = templateCheckCache.get(key);
  if (cached && Date.now() - cached.at < TEMPLATE_CHECK_TTL_MS) return cached.result;
  const result = await check().catch(() => false);
  templateCheckCache.set(key, { at: Date.now(), result });
  return result;
}
