import { Types } from "komodo_client";
import type { KomodoServer, KomodoServerState, KomodoStatus } from "@devlet/shared";
import { getKomodoClient, type Komodo } from "./komodo-client.js";
import { loadEffectivePlatformExclusions } from "./exclusions.js";

/**
 * Probe the Komodo core: reachability + version, managed servers, and per-server
 * GPU detection.
 *
 * Unlike Portainer (GPU is free from snapshot data), Komodo has no GPU field on
 * server info, so we detect it by running `nvidia-smi -L` on each online server.
 * That's an expensive terminal execution, so results are cached with a TTL and
 * deduped in-flight to avoid hammering servers on every probe.
 */

const GPU_TTL_MS = 5 * 60 * 1000;
const GPU_PROBE_TIMEOUT_MS = 15_000;

type GpuInfo = { gpuAvailable: boolean; gpuModel?: string };
type GpuCacheEntry = GpuInfo & { ts: number };

const gpuCache = new Map<string, GpuCacheEntry>();
const gpuInFlight = new Map<string, Promise<GpuInfo>>();

function normalizeState(state?: string): KomodoServerState {
  switch (state) {
    case "Ok":
      return "ok";
    case "NotOk":
      return "not-ok";
    case "Disabled":
      return "disabled";
    default:
      return "unknown";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function detectGpu(komodo: Komodo, serverName: string): Promise<GpuInfo> {
  const stream = await komodo.execute_terminal_stream({
    target: { type: "Server", params: { server: serverName } },
    terminal: `devlet-gpu-${serverName}`,
    command: "nvidia-smi -L 2>&1 || echo NO_NVIDIA_SMI",
    init: { command: "bash", recreate: Types.TerminalRecreateMode.Always },
  });
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const out = chunks.join("").trim();
  if (!out || out.includes("NO_NVIDIA_SMI") || !/GPU \d+:/i.test(out)) {
    return { gpuAvailable: false };
  }
  // First line looks like: "GPU 0: NVIDIA GeForce RTX 4080 (UUID: GPU-...)"
  const m = out.match(/GPU \d+:\s*(.+?)\s*\(UUID/m);
  return { gpuAvailable: true, gpuModel: m?.[1] };
}

async function getGpuForServer(komodo: Komodo, serverName: string): Promise<GpuInfo> {
  const cached = gpuCache.get(serverName);
  if (cached && Date.now() - cached.ts < GPU_TTL_MS) {
    return { gpuAvailable: cached.gpuAvailable, gpuModel: cached.gpuModel };
  }
  const inFlight = gpuInFlight.get(serverName);
  if (inFlight) return inFlight;

  const promise = withTimeout(detectGpu(komodo, serverName), GPU_PROBE_TIMEOUT_MS, {
    gpuAvailable: false,
  })
    .then((info) => {
      gpuCache.set(serverName, { ...info, ts: Date.now() });
      return info;
    })
    .catch(() => ({ gpuAvailable: false }))
    .finally(() => {
      gpuInFlight.delete(serverName);
    });

  gpuInFlight.set(serverName, promise);
  return promise;
}

export async function probeKomodo(): Promise<KomodoStatus> {
  const komodo = getKomodoClient();
  if (!komodo) {
    return {
      connected: false,
      servers: [],
      error: "Komodo is not configured (set KOMODO_URL / KOMODO_API_KEY / KOMODO_API_SECRET)",
    };
  }

  try {
    const [version, servers] = await Promise.all([
      komodo.core_version().catch(() => undefined),
      komodo.read("ListServers", {}),
    ]);

    const exclusions = await loadEffectivePlatformExclusions();
    const excludedSet = new Set(exclusions.komodoServers);

    const serverInfos: KomodoServer[] = await Promise.all(
      servers.map(async (s) => {
        const state = normalizeState(s.info?.state);
        const online = state === "ok";
        const gpu = online ? await getGpuForServer(komodo, s.name) : undefined;
        const host =
          (s.info?.external_address ?? s.info?.public_ip ?? s.info?.address ?? "").replace(
            /^https?:\/\//,
            ""
          ) || undefined;

        return {
          id: s.id,
          name: s.name,
          state,
          ...(host ? { host } : {}),
          ...(gpu
            ? {
                gpuAvailable: gpu.gpuAvailable,
                ...(gpu.gpuModel ? { gpuModel: gpu.gpuModel } : {}),
              }
            : {}),
          excluded: excludedSet.has(s.name) || excludedSet.has(s.id),
          totalMemoryGb: s.info?.stats?.mem_total_gb,
          usedMemoryGb: s.info?.stats?.mem_used_gb,
          coreCount: s.info?.logical_core_count ?? s.info?.core_count,
        };
      })
    );

    return { connected: true, ...(version ? { version } : {}), servers: serverInfos };
  } catch (error) {
    return {
      connected: false,
      servers: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
