export type PlatformType = "docker" | "portainer" | "proxmox" | "komodo";
export type PlatformArchitecture = "amd64" | "arm64" | "unknown";

export type PlatformTarget =
  | { type: "docker"; socketPath?: string }
  | { type: "portainer"; endpointId: number; endpointName?: string; stackName?: string }
  | { type: "proxmox"; node: string; vmType: "lxc" | "qemu" }
  | { type: "komodo"; serverId: string; serverName?: string };

// Status shapes returned by platform health checks
export interface DockerStatus {
  coreCount?: number;
  totalMemoryMb?: number;
  connected: boolean;
  /** False when the platform has no credentials/socket here; the UI hides it. Absent means configured. */
  configured?: boolean;
  version?: string;
  containers: { running: number; stopped: number; total: number };
  /** Whether the Docker host has GPU runtime support (nvidia-container-runtime) */
  gpuAvailable?: boolean;
  architecture?: PlatformArchitecture;
  error?: string;
}

export interface PortainerEndpoint {
  coreCount?: number;
  id: number;
  name: string;
  url: string;
  type: number;
  status: number;
  /** Whether this endpoint has hosts with GPU support */
  gpuAvailable?: boolean;
  /** Excluded from scheduling by configuration */
  excluded?: boolean;
  architecture?: PlatformArchitecture;
  /** Running container count from the latest snapshot */
  runningContainers?: number;
  /** Total host memory in MB from the latest snapshot */
  totalMemoryMb?: number;
}

export interface PortainerStack {
  id: number;
  name: string;
  status: number;
  endpointId: number;
}

export interface PortainerStatus {
  connected: boolean;
  /** False when the platform has no credentials/socket here; the UI hides it. Absent means configured. */
  configured?: boolean;
  version?: string;
  endpoints: PortainerEndpoint[];
  error?: string;
}

export interface DockerImage {
  id: string;
  tags: string[];
  sizeBytes: number;
  createdAt: string;
}

export interface ProxmoxNode {
  coreCount?: number;
  name: string;
  status: "online" | "offline" | "unknown";
  cpuUsage: number;        // 0–1 fraction
  memoryUsed: number;      // MB
  memoryTotal: number;     // MB
  /** Number of GPU devices available for passthrough on this node */
  gpuCount?: number;
  /** Excluded from scheduling by configuration */
  excluded?: boolean;
  architecture?: PlatformArchitecture;
}

export interface ProxmoxStatus {
  connected: boolean;
  /** False when the platform has no credentials/socket here; the UI hides it. Absent means configured. */
  configured?: boolean;
  version?: string;
  nodes: ProxmoxNode[];
  error?: string;
  // ── Provisioning readiness (see docs/proxmox-provisioning.md) ──
  /** Default node from PROXMOX_NODE (empty when unset). */
  defaultNode?: string;
  /** Storage pool for guest disks from PROXMOX_STORAGE. */
  storage?: string;
  /** Configured LXC template volid (empty when unset). */
  lxcTemplate?: string;
  /** Whether the LXC template exists on the default node's storage. */
  lxcTemplateReady?: boolean;
  /** Configured QEMU template VM id (0 = not configured). */
  qemuTemplateId?: number;
  /** Whether the QEMU template VM exists (as a template) in the cluster. */
  qemuTemplateReady?: boolean;
  /** Human-readable blocker when provisioning cannot proceed; absent when ready. */
  provisioningBlocker?: string;
}

/** Normalized Komodo server lifecycle state. */
export type KomodoServerState = "ok" | "not-ok" | "disabled" | "unknown";

export interface KomodoServer {
  id: string;
  name: string;
  state: KomodoServerState;
  /** Whether this server has GPU support (detected via nvidia-smi) */
  gpuAvailable?: boolean;
  /** Detected GPU model, e.g. "NVIDIA GeForce RTX 4080" */
  gpuModel?: string;
  /** Excluded from scheduling by configuration */
  excluded?: boolean;
  /** Reachable hostname/IP of this server (for proxying agent UI/SSH) */
  host?: string;
  architecture?: PlatformArchitecture;
  /** Total host memory in GB from the latest stats snapshot */
  totalMemoryGb?: number;
  /** Used host memory in GB from the latest stats snapshot */
  usedMemoryGb?: number;
  /** Logical core count */
  coreCount?: number;
}

export interface KomodoStatus {
  connected: boolean;
  /** False when the platform has no credentials/socket here; the UI hides it. Absent means configured. */
  configured?: boolean;
  version?: string;
  servers: KomodoServer[];
  error?: string;
}

export interface TailscaleStatus {
  /** OAuth client id + secret are present in the server env. */
  configured: boolean;
  /** An OAuth token could be obtained and the tailnet API answered. */
  connected: boolean;
  /** The Devlet server itself is on the tailnet (needed to proxy agents over it). */
  serverOnTailnet?: boolean;
  /** Devlet-tagged nodes currently on the tailnet. */
  agentNodes?: number;
  error?: string;
}
