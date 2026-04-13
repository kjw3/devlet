import type { PortainerStatus } from "@devlet/shared";
import { config } from "../config.js";
import { loadEffectivePlatformExclusions } from "./exclusions.js";

interface PortainerApiStatus {
  Version: string;
}

interface PortainerApiEndpoint {
  Id: number;
  Name: string;
  URL: string;
  Type: number;
  Status: number;
  Snapshots?: Array<{
    RunningContainerCount?: number;
    TotalMemory?: number;  // bytes
    DockerSnapshotRaw?: {
      Info?: {
        Runtimes?: Record<string, unknown>;
        Architecture?: string;
      };
    };
  }>;
}

function normalizeArchitecture(value: string | undefined): "amd64" | "arm64" | "unknown" {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "amd64" || normalized === "x86_64") return "amd64";
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  return "unknown";
}

export async function probePortainer(): Promise<PortainerStatus> {
  const { url, apiKey } = config.portainer;

  if (!url || !apiKey) {
    return {
      connected: false,
      endpoints: [],
      error: "PORTAINER_URL or PORTAINER_API_KEY not configured",
    };
  }

  const headers = {
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
  };

  try {
    const [statusRes, epRes] = await Promise.all([
      fetch(`${url}/api/status`, { headers }),
      fetch(`${url}/api/endpoints`, { headers }),
    ]);

    if (!statusRes.ok) throw new Error(`/api/status HTTP ${statusRes.status}`);
    if (!epRes.ok) throw new Error(`/api/endpoints HTTP ${epRes.status}`);

    const statusData = (await statusRes.json()) as PortainerApiStatus;
    const endpoints = (await epRes.json()) as PortainerApiEndpoint[];

    const exclusions = await loadEffectivePlatformExclusions();

    return {
      connected: true,
      version: statusData.Version,
      endpoints: endpoints.map((ep) => ({
        id: ep.Id,
        name: ep.Name,
        url: ep.URL,
        type: ep.Type,
        status: ep.Status,
        ...(exclusions.portainerEndpoints.includes(String(ep.Id)) ||
        exclusions.portainerEndpoints.includes(ep.Name)
          ? { excluded: true }
          : {}),
        ...(ep.Snapshots?.[0]?.DockerSnapshotRaw?.Info?.Runtimes?.["nvidia"] !== undefined
          ? { gpuAvailable: true }
          : {}),
        architecture: normalizeArchitecture(
          ep.Snapshots?.[0]?.DockerSnapshotRaw?.Info?.Architecture
        ),
        ...(ep.Snapshots?.[0]?.RunningContainerCount !== undefined
          ? { runningContainers: ep.Snapshots[0].RunningContainerCount }
          : {}),
        ...(ep.Snapshots?.[0]?.TotalMemory !== undefined
          ? { totalMemoryMb: Math.round(ep.Snapshots[0].TotalMemory / 1024 / 1024) }
          : {}),
      })),
    };
  } catch (err) {
    return {
      connected: false,
      endpoints: [],
      error: String(err),
    };
  }
}
