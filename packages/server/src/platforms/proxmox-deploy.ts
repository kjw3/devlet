import { getResourceMinimum, templateDiskGb, type AgentConfig } from "@devlet/shared";
import { randomBytes } from "node:crypto";
import { inspectGuestRuntime } from "./proxmox-runtime.js";
import { config } from "../config.js";
import { agentImageFor } from "./docker.js";
import { buildContainerEnv } from "./env.js";
import {
  allocateVmid,
  devletGuestName,
  firstGpuPciId,
  getLxcGuestIp,
  getQemuGuestIp,
  getStorageInfo,
  isGpuDevice,
  listClusterGuests,
  listHostpciInUse,
  listPciDevices,
  pciSlotKey,
  pickGpuPciId,
  pveDelete,
  pveGet,
  pvePost,
  pvePut,
  pvePutAsRoot,
  rootAuthHeaders,
  waitForTask,
  ProxmoxApiError,
  ProxmoxTaskError,
} from "./proxmox-client.js";
import { getProvisioningKey, isGuestSshReachable, runGuestScript } from "./proxmox-ssh.js";

/** PVE exposes hostpci0–hostpci3 per VM. */
export const MAX_HOSTPCI_DEVICES = 4;

/** Map selected GPU PCI ids onto hostpci slots — pure, so the wizard-order →
 *  slot mapping is unit-testable without a PVE host. */
export function buildHostpciEntries(deviceIds: string[]): Array<[string, string]> {
  return deviceIds.slice(0, MAX_HOSTPCI_DEVICES).map((id, i) => [`hostpci${i}`, id]);
}

// ─── Proxmox guest lifecycle (see docs/proxmox-provisioning.md) ────────────────
// Each agent gets a dedicated LXC container or QEMU VM (D3). The guest runs
// Docker; the existing agent image runs inside it with the same env the other
// platforms inject (D1). Guest commands run over SSH with the Devlet
// provisioning key (D2). Ports are fixed per guest, so no allocation race (D4).

const GUEST_IP_TIMEOUT_MS = 3 * 60 * 1000;
const GUEST_IP_POLL_MS = 3_000;
const BOOTSTRAP_TIMEOUT_MS = 12 * 60 * 1000;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function assertConfigured(): void {
  if (!config.proxmox.url || !config.proxmox.user || !config.proxmox.tokenSecret) {
    throw new Error("Proxmox is not configured (PROXMOX_URL / PROXMOX_USER / PROXMOX_TOKEN_SECRET)");
  }
}

function formatTaskError(err: unknown, what: string): Error {
  if (err instanceof ProxmoxTaskError) {
    const tail = err.taskLog.slice(-8).join("\n");
    return new Error(`Proxmox ${what} failed: ${err.message}${tail ? `\n${tail}` : ""}`);
  }
  if (err instanceof Error) return new Error(`Proxmox ${what} failed: ${err.message}`);
  return new Error(`Proxmox ${what} failed: ${String(err)}`);
}

/** Fixed guest ports (D4) — one agent per guest means no allocation race. */
function guestPortMappings(agentConfig: AgentConfig): string[] {
  const terminalPort = agentConfig.env["DEVLET_TERMINAL_PORT"] || "7681";
  const pairs = [`${terminalPort}:7681`];

  const sshPort = agentConfig.env["DEVLET_SSH_PORT"];
  if (sshPort) pairs.push(`${sshPort}:2222`);

  if (agentConfig.type === "openclaw") {
    const hostPort = agentConfig.env["OPENCLAW_HOST_PORT"] || "18789";
    pairs.push(`${hostPort}:18789`);
  }
  if (agentConfig.type === "moltis") {
    const hostPort = agentConfig.env["MOLTIS_HOST_PORT"] || "13131";
    pairs.push(`${hostPort}:13131`);
  }
  return pairs;
}

function guestResources(agentConfig: AgentConfig): {
  cores: number;
  memoryMb: number;
  diskGb: number;
} {
  const cores = Math.max(1, Math.round(agentConfig.resources.cpus || 1));
  const memoryMb = Math.max(getResourceMinimum(agentConfig.type, agentConfig.platform).memoryMb, Math.round(agentConfig.resources.memoryMb || 2048));
  const diskGb = Math.max(8, Math.ceil((agentConfig.resources.storageMb ?? 0) / 1024) || 10);
  return { cores, memoryMb, diskGb };
}

/** Single-quote a value so it survives the guest shell literally. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Fresh locally-administered MAC in PVE's BC:24:11 range. */
export function freshMac(): string {
  const tail = [...randomBytes(3)].map((b) => b.toString(16).padStart(2, "0").toUpperCase());
  return `BC:24:11:${tail.join(":")}`;
}

/** Clone-safe net0: keep the template's bridge/VLAN/firewall settings but give
 *  the clone its own MAC. PROXMOX_VLAN overrides any template VLAN; falls back
 *  to a plain config on PROXMOX_BRIDGE when the template has no net0. Exported
 *  for tests. */
export function readdressNet0(templateNet0: string): string {
  const macRe = /([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}/;
  let net0 = templateNet0
    ? templateNet0.replace(macRe, freshMac())
    : `virtio=${freshMac()},bridge=${config.proxmox.bridge},firewall=1`;
  if (config.proxmox.vlan) {
    net0 = /\btag=\d+/.test(net0)
      ? net0.replace(/\btag=\d+/, `tag=${config.proxmox.vlan}`)
      : `${net0},tag=${config.proxmox.vlan}`;
  }
  return net0;
}

/** Grow the clone's root disk to the requested size when the template's disk is
 *  smaller (never shrink). */
async function resizeQemuRootDisk(
  node: string,
  vmid: number,
  cloneConfig: Record<string, unknown> | null,
  diskGb: number
): Promise<void> {
  if (!cloneConfig) throw new Error("Cannot determine clone root disk");
  const rootDiskKey = ["scsi0", "virtio0", "sata0", "ide0"].find(
    (k) => typeof cloneConfig[k] === "string"
  );
  if (!rootDiskKey) throw new Error("Cannot determine clone root disk");
  const currentGb = templateDiskGb(cloneConfig);
  if (diskGb <= currentGb) return;
  await pvePut(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/resize`, {
    disk: rootDiskKey,
    size: `${diskGb}G`,
  });
}

// ─── Bootstrap script (D1) ─────────────────────────────────────────────────────

export async function buildBootstrapScript(agentConfig: AgentConfig): Promise<string> {
  const image = agentImageFor(agentConfig);
  const ports = guestPortMappings(agentConfig)
    .map((p) => `-p ${p}`)
    .join(" ");

  // GPU guests: the passthrough GPU is only usable when the guest's Docker can
  // hand it to containers — install the NVIDIA container toolkit and run the
  // agent with --gpus all. The host kernel driver itself comes from the GPU
  // QEMU template (docs/gpu-agents.md); fail loudly when it is missing.
  const gpuGuest =
    agentConfig.platform.type === "proxmox" &&
    agentConfig.platform.vmType === "qemu" &&
    Boolean(agentConfig.gpu?.required);

  // Docker `-e` args (values single-quoted; newlines and special chars survive).
  const env = await buildContainerEnv(agentConfig);
  const envArgs = env
    .map((entry) => {
      const idx = entry.indexOf("=");
      if (idx === -1) return "";
      return `-e ${entry.slice(0, idx)}=${shellQuote(entry.slice(idx + 1))}`;
    })
    .filter(Boolean)
    .join(" ");

  const restartPolicy = agentConfig.persistent ? "unless-stopped" : "no";

  return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Surviving SSH jobs and restarted servers must never launch the same task twice.
exec 9>/run/devlet-bootstrap.lock
flock -w 660 9 || { echo "[devlet] another bootstrap is still running"; exit 1; }

# Fresh cloud-image VMs run cloud-init (package updates, apt) on first boot —
# wait for it to finish or apt-get races for the lists lock.
if command -v cloud-init >/dev/null 2>&1; then
  timeout 300 cloud-init status --wait >/dev/null 2>&1 || true
fi

${agentConfig.platform.type === "proxmox" && agentConfig.platform.vmType === "qemu" ? `
# Cloud-init normally grows Ubuntu cloud-image roots. Explicitly grow the
# supported partition/filesystem layout and verify before launching the agent.
rootdev=$(findmnt -n -o SOURCE /)
fstype=$(findmnt -n -o FSTYPE /)
parent=$(lsblk -no PKNAME "$rootdev" | head -1)
part=$(cat "/sys/class/block/$(basename "$(readlink -f "$rootdev")")/partition" 2>/dev/null || true)
if [ -n "$parent" ] && [ -n "$part" ]; then
  command -v growpart >/dev/null || apt-get install -y -qq cloud-guest-utils >/dev/null
  growpart "/dev/$parent" "$part" || [ $? -eq 1 ]
  case "$fstype" in
    ext4|ext3|ext2) resize2fs "$rootdev" ;;
    xfs) xfs_growfs / ;;
    *) echo "Unsupported root filesystem: $fstype"; exit 1 ;;
  esac
fi
# Filesystem metadata and boot partitions consume part of the virtual disk.
rootbytes=$(df -B1 --output=size / | tail -1 | tr -d ' ')
[ "$rootbytes" -ge ${Math.floor(guestResources(agentConfig).diskGb * 1024 ** 3 * 0.85)} ] || { echo "Root filesystem did not grow to the requested disk budget; check template partition/LVM layout"; exit 1; }
` : ""}

if ! command -v docker >/dev/null 2>&1; then
  echo "[devlet] installing Docker on guest..."
  apt-get update -qq
  apt-get install -y -qq docker.io >/dev/null
fi

for i in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
docker info >/dev/null 2>&1 || { echo "[devlet] Docker daemon not ready"; exit 1; }
${gpuGuest ? `
# NVIDIA container toolkit — lets the agent container use the passed-through GPU.
if ! command -v nvidia-ctk >/dev/null 2>&1; then
  echo "[devlet] installing NVIDIA container toolkit..."
  apt-get update -qq
  apt-get install -y -qq gpg curl >/dev/null
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \\
    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \\
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update -qq
  apt-get install -y -qq nvidia-container-toolkit >/dev/null
  nvidia-ctk runtime configure --runtime=docker
  systemctl restart docker
fi
if ! nvidia-smi -L >/dev/null 2>&1; then
  echo "[devlet] no NVIDIA GPU visible inside guest — the QEMU template lacks the NVIDIA driver (docs/gpu-agents.md)"
  exit 1
fi
# The CUDA data plane needs the nvidia_uvm module (nvidia-smi works without
# it, but every allocation fails). Modules usually autoload lazily via
# nvidia-modprobe; load it at guest level so the first container CUDA call
# never races that. Best-effort: a missing module surfaces in the container's
# startup probe instead of failing the bootstrap.
modprobe nvidia_uvm 2>/dev/null || true
` : ""}

# An existing container (even exited) means the task was already launched.
# Never delete its workspace or rerun a completed single task during recovery.
existing=$(docker container ls -a --filter 'name=^/devlet-agent$' --format '{{.ID}}')
if [ -n "$existing" ]; then
  echo "[devlet] existing agent container retained"
  exit 0
fi

echo "[devlet] pulling agent image"
docker pull ${shellQuote(image)}
echo "[devlet] starting agent container"
docker run -d --name devlet-agent \\
  --restart ${restartPolicy} \\
  ${gpuGuest ? "--gpus all \\\n" : ""}\
  ${envArgs} \\
  ${ports} \\
  ${shellQuote(image)}

docker ps --filter name=devlet-agent --format '{{.Status}}'
`;
}

async function bootstrapGuest(agentConfig: AgentConfig, ip: string): Promise<void> {
  // SSH may take a moment after the guest's first boot.
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (await isGuestSshReachable(ip, 5_000)) break;
    if (Date.now() > deadline) {
      throw new Error(
        `Guest ${ip} SSH never became reachable — check that the provisioning key is authorized (template/cloud-init) and networking is up`
      );
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }

  const script = await buildBootstrapScript(agentConfig);
  const result = await runGuestScript(ip, script, { timeoutMs: BOOTSTRAP_TIMEOUT_MS });
  const statusLine = result.stdout.trim().split("\n").filter(Boolean).pop();
  if (statusLine) console.log(`[proxmox] guest ${ip} agent container: ${statusLine}`);
}

// ─── IP resolution (D5) ────────────────────────────────────────────────────────

async function waitGuestIp(node: string, vmType: "lxc" | "qemu", vmid: number): Promise<string> {
  const deadline = Date.now() + GUEST_IP_TIMEOUT_MS;
  for (;;) {
    const ip =
      vmType === "lxc" ? await getLxcGuestIp(node, vmid) : await getQemuGuestIp(node, vmid);
    if (ip) return ip;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for a guest IP on ${node} (${vmType} ${vmid}).` +
          (vmType === "qemu"
            ? " Ensure the QEMU template runs qemu-guest-agent and has agent: 1 enabled."
            : "")
      );
    }
    await new Promise((r) => setTimeout(r, GUEST_IP_POLL_MS));
  }
}

async function resolveGuestIp(
  node: string,
  vmType: "lxc" | "qemu",
  vmid: number
): Promise<string | null> {
  return vmType === "lxc" ? getLxcGuestIp(node, vmid) : getQemuGuestIp(node, vmid);
}

// ─── Guest status helpers ──────────────────────────────────────────────────────

async function getGuestStatus(
  node: string,
  vmType: "lxc" | "qemu",
  vmid: number
): Promise<{ status: string } | null> {
  try {
    return await pveGet<{ status: string }>(
      `/nodes/${encodeURIComponent(node)}/${vmType}/${vmid}/status/current`
    );
  } catch {
    return null;
  }
}

async function startGuest(node: string, vmType: "lxc" | "qemu", vmid: number): Promise<void> {
  try {
    const upid = await pvePost<string>(
      `/nodes/${encodeURIComponent(node)}/${vmType}/${vmid}/status/start`,
      {}
    );
    await waitForTask(upid, { timeoutMs: 5 * 60 * 1000 });
  } catch (err) {
    throw formatTaskError(err, `start of ${vmType} ${vmid}`);
  }
}

async function stopGuest(node: string, vmType: "lxc" | "qemu", vmid: number): Promise<void> {
  const status = await getGuestStatus(node, vmType, vmid);
  if (!status || status.status === "stopped") return;

  // Graceful shutdown first; force-stop as fallback. A guest that disappears
  // mid-teardown (destroyed out-of-band) is fine — treat as stopped.
  try {
    const upid = await pvePost<string>(
      `/nodes/${encodeURIComponent(node)}/${vmType}/${vmid}/status/shutdown`,
      { timeout: 60, forceStop: 1 }
    );
    await waitForTask(upid, { timeoutMs: 90 * 1000 });
    return;
  } catch (err) {
    if (
      (err instanceof ProxmoxApiError || err instanceof ProxmoxTaskError) &&
      /does not exist|no such (vm|container|guest)/i.test(err.message)
    ) {
      return;
    }
    // fall through to force stop
  }
  try {
    const upid = await pvePost<string>(
      `/nodes/${encodeURIComponent(node)}/${vmType}/${vmid}/status/stop`,
      {}
    );
    await waitForTask(upid, { timeoutMs: 60 * 1000 });
  } catch (err) {
    if (
      (err instanceof ProxmoxApiError || err instanceof ProxmoxTaskError) &&
      /does not exist|no such (vm|container|guest)/i.test(err.message)
    ) {
      return;
    }
    throw formatTaskError(err, `stop of ${vmType} ${vmid}`);
  }
}

async function destroyGuest(node: string, vmType: "lxc" | "qemu", vmid: number): Promise<void> {
  try {
    await stopGuest(node, vmType, vmid);
    const upid = await pveDelete<string>(`/nodes/${encodeURIComponent(node)}/${vmType}/${vmid}`);
    if (upid) await waitForTask(upid, { timeoutMs: 5 * 60 * 1000 });
  } catch (err) {
    // Already gone: PVE reports 404/400 for some paths but 500 with a message
    // for missing config files (observed live: "Configuration file
    // 'nodes/pc1/lxc/4857.conf' does not exist"). Treat as success — the
    // desired state (guest gone) is achieved.
    if (err instanceof ProxmoxApiError && (err.status === 404 || err.status === 400)) {
      return;
    }
    if (
      err instanceof ProxmoxApiError ||
      err instanceof ProxmoxTaskError
    ) {
      if (/does not exist|no such (vm|container|guest)/i.test(err.message)) return;
    }
    throw formatTaskError(err, `destroy of ${vmType} ${vmid}`);
  }
}

// ─── Create: LXC + QEMU paths ──────────────────────────────────────────────────

export async function findTemplateNode(templateId: number): Promise<string | null> {
  try {
    const guests = await listClusterGuests();
    return guests.find((g) => g.vmid === templateId && g.template === 1)?.node ?? null;
  } catch {
    return null;
  }
}

async function createLxcGuest(
  agentConfig: AgentConfig,
  node: string,
  vmid: number,
  markCreated: () => void
): Promise<void> {
  const { cores, memoryMb, diskGb } = guestResources(agentConfig);
  const { publicKey } = await getProvisioningKey();
  const hostname = devletGuestName(agentConfig.id);

  try {
    const upid = await pvePost<string>(`/nodes/${encodeURIComponent(node)}/lxc`, {
      vmid,
      hostname,
      ostemplate: config.proxmox.lxcTemplate,
      rootfs: `${config.proxmox.storage}:${diskGb}`,
      cores,
      memory: memoryMb,
      swap: 0,
      net0: `name=eth0,bridge=${config.proxmox.bridge},ip=dhcp,firewall=0${
        config.proxmox.vlan ? `,tag=${config.proxmox.vlan}` : ""
      }`,
      unprivileged: 1,
      // PVE only allows root@pam to set feature flags other than nesting —
      // with a least-privilege token, keyctl cannot be set at create time.
      // Docker works with nesting=1 on modern kernels; guests that truly need
      // keyctl should use a gold-image clone that already carries it.
      features: "nesting=1",
      "ssh-public-keys": publicKey,
      description: `Devlet agent ${agentConfig.id} — managed by Devlet (docs/proxmox-provisioning.md)`,
      start: 0,
    });
    await waitForTask(upid, { timeoutMs: 10 * 60 * 1000 });
    markCreated();
  } catch (err) {
    throw formatTaskError(err, `LXC creation (vmid ${vmid})`);
  }

  try {
    const startUpid = await pvePost<string>(
      `/nodes/${encodeURIComponent(node)}/lxc/${vmid}/status/start`,
      {}
    );
    await waitForTask(startUpid, { timeoutMs: 3 * 60 * 1000 });
  } catch (err) {
    throw formatTaskError(err, `LXC start (vmid ${vmid})`);
  }
}

/**
 * Pick the storage a QEMU clone should write to, and whether the clone can be
 * linked (CoW, near-instant) instead of full. A linked clone shares the base
 * volume and therefore must land on the template's own storage — which only
 * works when that storage is shared (visible on the target node too). Full
 * clones can go anywhere, but cross-node full clones need a shared storage
 * ("can't clone to non-shared storage").
 *
 * Resolution order:
 *  1. PROXMOX_QEMU_STORAGE (explicit override)
 *  2. PROXMOX_STORAGE when target == template node
 *  3. the template's own root-disk storage, when it is shared
 *  4. error with guidance
 *
 * When the resolved storage equals the template's disk storage the clone is
 * linked; put the template on ceph-vms to get instant linked clones.
 */
export async function resolveQemuCloneStorage(
  templateNode: string,
  targetNode: string,
  templateId = config.proxmox.qemuTemplateId
): Promise<{ storage: string; linked: boolean }> {

  let templateDiskStorage = "";
  let templateDiskShared = false;
  try {
    const cfg = await pveGet<Record<string, unknown>>(
      `/nodes/${encodeURIComponent(templateNode)}/qemu/${templateId}/config`
    );
    const diskKey = ["scsi0", "virtio0", "sata0", "ide0"].find((k) => typeof cfg[k] === "string");
    if (diskKey) templateDiskStorage = String(cfg[diskKey]).split(":")[0] || "";
  } catch {
    // template config unreadable — full-clone fallbacks below still apply
  }
  if (templateDiskStorage) {
    const info = await getStorageInfo(templateNode, templateDiskStorage);
    templateDiskShared = info?.shared ?? false;
  }

  let storage = "";
  if (config.proxmox.qemuStorage) {
    storage = config.proxmox.qemuStorage;
  } else if (targetNode === templateNode) {
    storage = config.proxmox.storage;
  } else {
    const candidates = [templateDiskStorage, config.proxmox.storage].filter(Boolean);
    for (const candidate of candidates) {
      const info = await getStorageInfo(targetNode, candidate);
      if (info?.shared && info.content.includes("images")) {
        storage = candidate;
        break;
      }
    }
  }

  if (!storage) {
    throw new Error(
      `cannot clone QEMU template to node ${targetNode}: no shared storage found` +
        ` (template disk storage: ${templateDiskStorage || "unknown"}, PROXMOX_STORAGE: ${config.proxmox.storage})` +
        ` — set PROXMOX_QEMU_STORAGE to a shared storage with images content`
    );
  }

  const linked = templateDiskShared && storage === templateDiskStorage;
  return { storage, linked };
}

async function createQemuGuest(
  agentConfig: AgentConfig,
  node: string,
  vmid: number,
  markCreated: () => void
): Promise<void> {
  const { cores, memoryMb, diskGb } = guestResources(agentConfig);
  // GPU hires clone the dedicated GPU template (NVIDIA driver baked in) when
  // one is configured; everything else uses the standard QEMU template.
  const templateId =
    agentConfig.gpu?.required && config.proxmox.qemuGpuTemplateId
      ? config.proxmox.qemuGpuTemplateId
      : config.proxmox.qemuTemplateId;
  if (!templateId) {
    throw new Error(
      agentConfig.gpu?.required && !config.proxmox.qemuGpuTemplateId
        ? "PROXMOX_QEMU_TEMPLATE_ID is not set — cannot create a QEMU agent " +
          "(for GPU agents, PROXMOX_QEMU_GPU_TEMPLATE_ID is recommended — docs/gpu-agents.md)"
        : "PROXMOX_QEMU_TEMPLATE_ID is not set — cannot create a QEMU agent"
    );
  }

  const templateNode = await findTemplateNode(templateId);
  if (!templateNode) {
    throw new Error(`QEMU template VM ${templateId} not found in the cluster`);
  }

  // Cross-node clones cannot write to node-local storage ("can't clone to
  // non-shared storage"): resolve a storage that works for the target node.
  // Linked clones (same storage as the template, shared) skip the disk copy.
  const { storage: cloneStorage, linked } = await resolveQemuCloneStorage(templateNode, node, templateId);

  const name = devletGuestName(agentConfig.id);
  try {
    const cloneUpid = await pvePost<string>(
      `/nodes/${encodeURIComponent(templateNode)}/qemu/${templateId}/clone`,
      {
        newid: vmid,
        name,
        full: linked ? 0 : 1,
        target: node,
        // Linked clones share the base volume — storage is implied (and the
        // API rejects it); only full clones take a destination storage.
        ...(linked ? {} : { storage: cloneStorage }),
      }
    );
    await waitForTask(cloneUpid, { timeoutMs: 15 * 60 * 1000 });
    markCreated();
  } catch (err) {
    throw formatTaskError(err, `QEMU clone (template ${templateId} → vmid ${vmid})`);
  }

  // Adjust the clone while it is still stopped: resources, fresh MAC (full
  // clones inherit the template's MAC — two guests with one MAC conflict on
  // ARP), cloud-init keys for the root user, GPU passthrough, disk growth.
  try {
    const cloneConfig = await pveGet<Record<string, unknown>>(
      `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`
    ).catch(() => null);

    const configUpdate: Record<string, string | number> = { cores, memory: memoryMb };

    const usesCloudInit =
      cloneConfig != null &&
      (["ciuser", "sshkeys", "cipassword", "ipconfig0"].some((k) => k in cloneConfig) ||
        String(cloneConfig["ide2"] ?? "").includes("cloudinit"));
    if (usesCloudInit) {
      // Force root so the bootstrap SSH (root@) works regardless of the
      // template's default distro user (e.g. "ubuntu" on Ubuntu cloud images).
      const { publicKey } = await getProvisioningKey();
      configUpdate["ciuser"] = "root";
      // PVE's qemu sshkeys config value must be URI-encoded (spaces/newlines
      // are illegal in raw config values) — matching the form the template
      // itself stores. LXC's "ssh-public-keys" create param takes plain text;
      // this one is different.
      configUpdate["sshkeys"] = encodeURIComponent(publicKey);
    }

    const templateNet0 = typeof cloneConfig?.["net0"] === "string" ? cloneConfig["net0"] : "";
    configUpdate["net0"] = readdressNet0(templateNet0);

    // D6: template-first GPU passthrough. PROXMOX_GPU_PCI_ID overrides;
    // otherwise auto-detect the target node's first usable GPU — PCI addresses
    // differ per node, so a single static id cannot cover a cluster. Devices
    // already passed through to other VMs are rejected up front (clear error
    // instead of a vfio failure at VM start).
    const wantsGpu = Boolean(agentConfig.gpu?.required) || Boolean(config.proxmox.gpuPciId);
    const selectedGpuDevices = agentConfig.gpu?.devices ?? [];
    if (wantsGpu) {
      if (config.proxmox.gpuPciId) {
        const inUse = await listHostpciInUse(node);
        const owner = inUse.get(config.proxmox.gpuPciId.replace(/\.[0-9a-f]+$/, "").toLowerCase());
        if (owner) {
          throw new Error(
            `GPU ${config.proxmox.gpuPciId} is already assigned to ${owner} on node ${node}`
          );
        }
        configUpdate["hostpci0"] = `${config.proxmox.gpuPciId},pcie=1`;
      } else if (selectedGpuDevices.length > 0) {
        // GPUs explicitly chosen in the hire wizard — map them onto hostpci
        // slots after a fresh free/busy check against the node.
        const [devices, inUse] = await Promise.all([listPciDevices(node), listHostpciInUse(node)]);
        const gpuIds = new Set(devices.filter(isGpuDevice).map((d) => pciSlotKey(d.id)));
        for (const id of selectedGpuDevices) {
          if (!gpuIds.has(pciSlotKey(id))) {
            throw new Error(`GPU ${id} is not a GPU-class PCI device on node ${node}`);
          }
          const owner = inUse.get(pciSlotKey(id));
          if (owner) {
            throw new Error(`GPU ${id} is already assigned to ${owner} on node ${node}`);
          }
        }
        if (selectedGpuDevices.length > MAX_HOSTPCI_DEVICES) {
          throw new Error(`At most ${MAX_HOSTPCI_DEVICES} GPUs can be passed to one VM (requested: ${selectedGpuDevices.length})`);
        }
        for (const [slot, id] of buildHostpciEntries(selectedGpuDevices)) {
          configUpdate[slot] = `${id},pcie=1`;
        }
      } else {
        const picked = await pickGpuPciId(node);
        if (!picked) {
          throw new Error(
            `GPU agent requested but no free GPU is available on node ${node} ` +
              "(all detected GPUs are already assigned to other VMs, or none is present)"
          );
        }
        configUpdate["hostpci0"] = `${picked.id},pcie=1`;
      }
    }

    // PVE restricts hostpci* (and args) to root@pam — API tokens of ordinary
    // users get "only root can set 'hostpci0' config" even with full
    // privileges. GPU hires therefore put the whole config update through an
    // optional dedicated root token; everything else stays least-privileged.
    if (configUpdate["hostpci0"] !== undefined) {
      const root = rootAuthHeaders();
      if (!root) {
        throw new Error(
          "GPU passthrough requires a root@pam API token (PVE restricts hostpci to root) — " +
            "set PROXMOX_ROOT_USER, PROXMOX_ROOT_TOKEN_ID and PROXMOX_ROOT_TOKEN_SECRET"
        );
      }
      await pvePutAsRoot(
        `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`,
        configUpdate
      );
    } else {
      await pvePut(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`, configUpdate);
    }

    // Grow the root disk when the agent asks for more than the template has.
    await resizeQemuRootDisk(node, vmid, cloneConfig, diskGb);
  } catch (err) {
    throw formatTaskError(err, `QEMU config (vmid ${vmid})`);
  }

  try {
    const startUpid = await pvePost<string>(
      `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/start`,
      {}
    );
    await waitForTask(startUpid, { timeoutMs: 5 * 60 * 1000 });
  } catch (err) {
    throw formatTaskError(err, `QEMU start (vmid ${vmid})`);
  }
}

// ─── Deploy operations (dispatch contract) ─────────────────────────────────────

/**
 * Create (or reuse) the guest for this agent and start the agent container in
 * it. Returns the platformRef `proxmox:{node}:{vmType}:{vmId}`.
 */
export async function createProxmoxGuest(agentConfig: AgentConfig, recoveringProvision = false): Promise<string> {
  if (!config.proxmox.url || !config.proxmox.user || !config.proxmox.tokenSecret) {
    throw new Error("Proxmox is not configured (PROXMOX_URL / PROXMOX_USER / PROXMOX_TOKEN_SECRET)");
  }

  const targetNode = agentConfig.platform.type === "proxmox" ? agentConfig.platform.node : "";
  const vmType: "lxc" | "qemu" =
    agentConfig.platform.type === "proxmox" ? agentConfig.platform.vmType : "lxc";

  const allocation = await allocateVmid(agentConfig.id);
  const vmid = allocation.vmid;

  // Reuse path (D3): a guest named devlet-{agentId} already exists.
  if (allocation.existingGuest) {
    const { node, vmType: existingType, vmid: existingId } = allocation.existingGuest;
    const status = await getGuestStatus(node, existingType, existingId);
    if (status?.status !== "running") await startGuest(node, existingType, existingId);
    const ip = await waitGuestIp(node, existingType, existingId);
    // A powered-on guest can contain a stopped agent. Restart the existing
    // container (preserving its workspace), not just the enclosing guest.
    const runtime = await inspectGuestRuntime(ip);
    if (recoveringProvision) {
      // Bootstrap is locked and idempotent, including when Docker installation
      // was interrupted. An exited task is adopted, never started a second time.
      await bootstrapGuest(agentConfig, ip);
    } else if (runtime === "missing") await bootstrapGuest(agentConfig, ip);
    else if (runtime === false) {
      await runGuestScript(ip, "docker start devlet-agent", { timeoutMs: 30_000 });
    } else if (runtime === null) {
      throw new Error(`Cannot determine agent container state on guest ${ip}; retry recovery later`);
    }
    return `proxmox:${node}:${existingType}:${existingId}`;
  }

  // Create path.
  if (!targetNode) {
    throw new Error("No Proxmox node selected (platform placement is missing a node)");
  }

  // Recheck current free space immediately before allocation. Existing guests
  // bypass this: recovery must not attempt to resize an already-running disk.
  const { validateDisk } = await import("./disk.js");
  const storageMb = await validateDisk(agentConfig.platform, agentConfig.resources.storageMb, agentConfig.id, Boolean(agentConfig.gpu?.required));
  if (storageMb !== undefined) agentConfig.resources.storageMb = storageMb;

  let created = false;
  const markCreated = (): void => {
    created = true;
  };
  try {
    if (vmType === "qemu") {
      await createQemuGuest(agentConfig, targetNode, vmid, markCreated);
    } else {
      await createLxcGuest(agentConfig, targetNode, vmid, markCreated);
    }
    created = true;

    const ip = await waitGuestIp(targetNode, vmType, vmid);
    await bootstrapGuest(agentConfig, ip);
    return `proxmox:${targetNode}:${vmType}:${vmid}`;
  } catch (err) {
    // Clean up partially created guests so failed hires leave no orphans.
    if (created) {
      await destroyGuest(targetNode, vmType, vmid).catch(() => {});
    }
    throw err;
  }
}

export async function stopProxmoxGuest(
  node: string,
  vmType: "lxc" | "qemu",
  vmid: number
): Promise<void> {
  await stopGuest(node, vmType, vmid);
}

export async function removeProxmoxGuest(
  node: string,
  vmType: "lxc" | "qemu",
  vmid: number
): Promise<void> {
  await destroyGuest(node, vmType, vmid);
}

/** Agent runtime state, not just guest power: false on exit, null on probe failure. */
export async function getProxmoxGuestRunning(
  node: string,
  vmType: "lxc" | "qemu",
  vmid: number
): Promise<boolean | null> {
  try {
    const status = await pveGet<{ status: string }>(
      `/nodes/${encodeURIComponent(node)}/${vmType}/${vmid}/status/current`
    );
    if (status.status === "stopped") return false;
    if (status.status !== "running") return null;
    const ip = await resolveGuestIp(node, vmType, vmid);
    if (!ip) return null;
    const runtime = await inspectGuestRuntime(ip);
    return runtime === "missing" ? false : runtime;
  } catch (err) {
    // Guest gone (destroyed out-of-band): report false so the reconciler can
    // reprovision persistent agents. API-level failures stay null.
    if (err instanceof ProxmoxApiError) {
      if (err.status === 404 || /no such (vm|container)|configuration file .* does not exist/i.test(err.message)) return false;
    }
    return null;
  }
}

/** Agent container logs via SSH; [] when the guest is unreachable. */
export async function getProxmoxGuestLogs(
  node: string,
  vmType: "lxc" | "qemu",
  vmid: number,
  tail = 200
): Promise<string[]> {
  try {
    const ip = await resolveGuestIp(node, vmType, vmid);
    if (!ip) return [];
    const result = await runGuestScript(
      ip,
      `docker logs --tail ${tail} devlet-agent 2>&1 || true`,
      { timeoutMs: 30_000 }
    );
    return result.stdout.split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}
