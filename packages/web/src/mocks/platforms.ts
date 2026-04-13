import type { DockerStatus, PortainerStatus, ProxmoxStatus } from "@devlet/shared";

export const MOCK_DOCKER_STATUS: DockerStatus = {
  connected: true,
  version: "27.4.1",
  containers: { running: 3, stopped: 5, total: 8 },
  gpuAvailable: false, // local Docker host has no nvidia-container-runtime
  architecture: "amd64",
};

export const MOCK_PORTAINER_STATUS: PortainerStatus = {
  connected: true,
  version: "2.21.0",
  endpoints: [
    {
      id: 1,
      name: "local",
      url: "unix:///var/run/docker.sock",
      type: 1,
      status: 1,
      gpuAvailable: false,
      architecture: "amd64",
    },
    {
      id: 2,
      name: "remote-01",
      url: "tcp://10.0.0.10:2376",
      type: 1,
      status: 1,
      gpuAvailable: true, // remote host has nvidia-container-runtime
      architecture: "arm64",
    },
  ],
};

export const MOCK_PROXMOX_STATUS: ProxmoxStatus = {
  connected: false,
  nodes: [],
  error: "Connection refused — check PROXMOX_HOST and credentials",
};

// Alternative mock with Proxmox online — useful for testing GPU scheduling
export const MOCK_PROXMOX_STATUS_ONLINE: ProxmoxStatus = {
  connected: true,
  version: "8.1.4",
  nodes: [
    {
      name: "pve-01",
      status: "online",
      cpuUsage: 0.35,
      memoryUsed: 32768,
      memoryTotal: 131072,
      gpuCount: 2,
      architecture: "amd64",
    },
    {
      name: "pve-02",
      status: "online",
      cpuUsage: 0.12,
      memoryUsed: 8192,
      memoryTotal: 65536,
      gpuCount: 0,
      architecture: "arm64",
    },
  ],
};
