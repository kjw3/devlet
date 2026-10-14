import { Types } from "komodo_client";
import type { KomodoServer, KomodoServerState, KomodoStatus } from "@devlet/shared";
import { getKomodoClient, type Komodo } from "./komodo-client.js";
import { loadEffectivePlatformExclusions } from "./exclusions.js";
import { config as appConfig } from "../config.js";

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
const GPU_PROBE_TIMEOUT_MS = 45_000; // first run on a GPU host may pull debian:12-slim

type GpuInfo = { gpuAvailable: boolean; gpuModel?: string };
type GpuCacheEntry = GpuInfo & { ts: number };

const gpuCache = new Map<string, GpuCacheEntry>();
const gpuInFlight = new Map<string, Promise<GpuInfo>>();

// A server's LAN address changes rarely; cache it (including "couldn't detect") for an hour.
const HOST_TTL_MS = 60 * 60 * 1000;
const HOST_PROBE_TIMEOUT_MS = 45_000; // first run may pull busybox on the server
const hostCache = new Map<string, { host: string | null; ts: number }>();
const hostInFlight = new Map<string, Promise<string | null>>();

// Komodo's periphery often runs in a container, where `ip route` only sees the Docker
// bridge. In that case ask the real host network namespace via a throwaway --net=host
// container. The command prints the kernel's chosen source address for an outbound route.
const LAN_IP_COMMAND =
  "if [ -f /.dockerenv ]; then docker run --rm --net=host busybox:1.37 ip -4 route get 1.1.1.1 2>/dev/null; " +
  "else ip -4 route get 1.1.1.1 2>/dev/null; fi";

async function detectLanHost(komodo: Komodo, serverName: string): Promise<string | null> {
  const stream = await komodo.execute_terminal_stream({
    target: { type: "Server", params: { server: serverName } },
    terminal: `devlet-host-${serverName}`,
    command: LAN_IP_COMMAND,
    init: { command: "bash", recreate: Types.TerminalRecreateMode.Always },
  });
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  // `ip` colours its output on a tty; strip ANSI escapes before matching.
  const output = chunks.join("").replace(/\u001b\[[0-9;]*m/g, "");
  const match = output.match(/\bsrc (\d{1,3}(?:\.\d{1,3}){3})\b/);
  return match?.[1] ?? null;
}

async function getLanHostForServer(komodo: Komodo, serverName: string): Promise<string | null> {
  const cached = hostCache.get(serverName);
  if (cached && Date.now() - cached.ts < HOST_TTL_MS) return cached.host;
  const inFlight = hostInFlight.get(serverName);
  if (inFlight) return inFlight;

  const promise = withTimeout(detectLanHost(komodo, serverName), HOST_PROBE_TIMEOUT_MS, null)
    .catch(() => null)
    .then((host) => {
      hostCache.set(serverName, { host, ts: Date.now() });
      return host;
    })
    .finally(() => {
      hostInFlight.delete(serverName);
    });

  hostInFlight.set(serverName, promise);
  return promise;
}

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

// Host-level nvidia-smi when the Komodo agent runs on the host. When it runs in a container
// (no nvidia-smi, no /dev/nvidia*), use Docker's NVIDIA runtime instead, which injects
// nvidia-smi into any glibc container started with --gpus all. The runtime check keeps
// servers without NVIDIA support from pulling an image they cannot use.
const GPU_COMMAND =
  "{ nvidia-smi -L 2>/dev/null || " +
  "{ [ -f /.dockerenv ] && docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia && " +
  "docker run --rm --gpus all debian:12-slim nvidia-smi -L 2>/dev/null; }; } || echo NO_NVIDIA_SMI";

async function detectGpu(komodo: Komodo, serverName: string): Promise<GpuInfo> {
  const stream = await komodo.execute_terminal_stream({
    target: { type: "Server", params: { server: serverName } },
    terminal: `devlet-gpu-${serverName}`,
    command: GPU_COMMAND,
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
      configured: false,
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
        // Preference: explicit KOMODO_SERVER_HOSTS mapping, then the address Komodo
        // has for the server, then the LAN address detected on the server itself, then a
        // dotted server name (likely an FQDN), and only last the public IP (a shared WAN
        // address that is rarely the server itself).
        const mapped = appConfig.komodo.serverHosts[s.name] ?? appConfig.komodo.serverHosts[s.id];
        const komodoAddress = s.info?.external_address || s.info?.address || "";
        const detected =
          online && !mapped && !komodoAddress ? await getLanHostForServer(komodo, s.name) : null;
        const host =
          (
            mapped ??
            (komodoAddress || detected || (s.name.includes(".") ? s.name : "") || s.info?.public_ip || "")
          ).replace(/^https?:\/\//, "") || undefined;

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
