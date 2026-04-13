import type { PortainerStatus } from "@devlet/shared";
import { config } from "../config.js";

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
    DockerSnapshotRaw?: {
      Info?: {
        Runtimes?: Record<string, unknown>;
      };
    };
  }>;
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

    return {
      connected: true,
      version: statusData.Version,
      endpoints: endpoints.map((ep) => ({
        id: ep.Id,
        name: ep.Name,
        url: ep.URL,
        type: ep.Type,
        status: ep.Status,
        ...(ep.Snapshots?.[0]?.DockerSnapshotRaw?.Info?.Runtimes?.["nvidia"] !== undefined
          ? { gpuAvailable: true }
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
