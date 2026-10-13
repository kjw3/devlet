export type PlatformType = "docker" | "portainer" | "proxmox" | "komodo";
export type PlatformArchitecture = "amd64" | "arm64" | "unknown";

export type PlatformTarget =
  | { type: "docker"; socketPath?: string }
  | { type: "portainer"; endpointId: number; endpointName?: string; stackName?: string }
  | { type: "proxmox"; node: string; vmType: "lxc" | "qemu" }
  | { type: "komodo"; serverId: string; serverName?: string };

// Status shapes returned by platform health checks
export interface DockerStatus {
  connected: boolean;
  version?: string;
  containers: { running: number; stopped: number; total: number };
  /** Whether the Docker host has GPU runtime support (nvidia-container-runtime) */
  gpuAvailable?: boolean;
  architecture?: PlatformArchitecture;
  error?: string;
}

export interface PortainerEndpoint {
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
  version?: string;
  nodes: ProxmoxNode[];
  error?: string;
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
  version?: string;
  servers: KomodoServer[];
  error?: string;
}
