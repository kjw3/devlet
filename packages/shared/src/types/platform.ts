export type PlatformType = "docker" | "portainer" | "proxmox";

export type PlatformTarget =
  | { type: "docker"; socketPath?: string }
  | { type: "portainer"; endpointId: number; stackName?: string }
  | { type: "proxmox"; node: string; vmType: "lxc" | "qemu" };

// Status shapes returned by platform health checks
export interface DockerStatus {
  connected: boolean;
  version?: string;
  containers: { running: number; stopped: number; total: number };
  /** Whether the Docker host has GPU runtime support (nvidia-container-runtime) */
  gpuAvailable?: boolean;
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
}

export interface ProxmoxStatus {
  connected: boolean;
  version?: string;
  nodes: ProxmoxNode[];
  error?: string;
}
