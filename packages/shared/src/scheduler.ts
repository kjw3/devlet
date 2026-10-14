/**
 * Intelligent placement scheduler.
 *
 * Pure function — no I/O, no side effects. Runs identically in the browser
 * (hire wizard preview) and on the server (authoritative placement at hire time).
 *
 * Scoring model
 * ─────────────
 * Each platform is evaluated in two phases:
 *
 *   1. Hard gates   — disqualify if connectivity or GPU constraints cannot be met.
 *   2. Soft scoring — 0–100 points across affinity, persistence, resource fit, load.
 *
 * The highest-scoring available platform wins. Ties are broken by platform
 * preference order: docker > portainer > proxmox > komodo.
 */

import type { AgentType } from "./types/agent.js";
import type {
  DockerStatus,
  PlatformArchitecture,
  PortainerStatus,
  ProxmoxStatus,
  KomodoStatus,
  PlatformTarget,
} from "./types/platform.js";
import type {
  PlacementRequirements,
  PlacementDecision,
  PlatformScore,
  SchedulerContext,
} from "./types/scheduler.js";

// ─── Type affinity tables ─────────────────────────────────────────────────────
// How well each agent type fits each platform (0–30). Higher = stronger preference.

const DOCKER_AFFINITY: Record<AgentType, number> = {
  "hermes": 30,       // Lightweight, ephemeral — Docker is the natural home
  "claude-code": 25,  // Lightweight code agent — fast local container
  "codex": 25,        // Same as claude-code
  "opencode": 25,     // Lightweight multi-provider agent
  "pi": 25,           // Minimal coding harness
  "gemini": 25,       // Google Gemini CLI — lightweight, ephemeral
  "nanoclaw": 0,      // Hard-gated: spawns its own containers — Proxmox only
  "openclaw": 15,     // Gateway agent — fine on Docker, better on Portainer
  "moltis": 15,       // Persistent gateway — Docker works, Portainer preferred
  "nemoclaw": 5,      // GPU-heavy NLP — Docker last resort (no passthrough by default)
};

const PORTAINER_AFFINITY: Record<AgentType, number> = {
  "openclaw": 25,     // Multi-instance gateway — Portainer is ideal
  "moltis": 25,       // Persistent gateway service — Portainer manages lifecycle well
  "hermes": 20,       // Managed orchestration suits Hermes pipelines
  "claude-code": 15,  // Fine on Portainer if Docker is busy
  "codex": 15,
  "opencode": 15,
  "pi": 15,
  "gemini": 15,
  "nanoclaw": 0,      // Hard-gated: spawns its own containers — Proxmox only
  "nemoclaw": 10,     // Can use container GPU passthrough
};

const PROXMOX_AFFINITY: Record<AgentType, number> = {
  "nemoclaw": 30,     // GPU passthrough, isolated VM — perfect for heavy NLP
  "openclaw": 20,     // Can run well in an LXC
  "moltis": 15,       // Persistent service benefits from VM/LXC isolation
  "claude-code": 10,  // Works, but overkill for a code agent
  "codex": 10,
  "opencode": 10,
  "pi": 10,
  "gemini": 10,
  "nanoclaw": 10,
  "hermes": 5,        // Proxmox is too heavy for a lightweight dispatcher
};

const KOMODO_AFFINITY: Record<AgentType, number> = {
  "openclaw": 25,     // Multi-instance gateway — Komodo deployments are ideal
  "moltis": 25,       // Persistent gateway service — named deployment lifecycle
  "hermes": 20,       // Managed orchestration suits Hermes pipelines
  "claude-code": 15,
  "codex": 15,
  "opencode": 15,
  "pi": 15,
  "gemini": 15,
  "nanoclaw": 0,      // Hard-gated: spawns its own containers — Proxmox only
  "nemoclaw": 20,     // Container GPU passthrough on Komodo GPU servers
};

function architectureScore(arch: PlatformArchitecture | undefined): number {
  if (arch === "amd64") return 4;
  if (arch === "arm64") return 1;
  return 0;
}

function architectureReason(arch: PlatformArchitecture | undefined): string | null {
  if (arch === "amd64") return "amd64 host — broadest compatibility for toolchain dependencies";
  if (arch === "arm64") return "arm64 host — suitable for ARM systems such as Jetson";
  return null;
}

// ─── Host pool selection ──────────────────────────────────────────────────────

/**
 * Choose which hosts a workload may land on. GPU work needs a GPU host. Everything
 * else goes to non-GPU hosts so GPU machines stay free for GPU work, and only falls
 * back to a GPU host when no other host is online.
 */
function selectHostPool<T>(
  online: T[],
  gpuHosts: T[],
  gpuRequired: boolean
): { pool: T[]; usingReservedGpuHost: boolean } {
  if (gpuRequired) return { pool: gpuHosts, usingReservedGpuHost: false };
  const nonGpu = online.filter((host) => !gpuHosts.includes(host));
  if (nonGpu.length > 0) return { pool: nonGpu, usingReservedGpuHost: false };
  return { pool: online, usingReservedGpuHost: gpuHosts.length > 0 };
}

// Applied when a platform can only offer a GPU host for non-GPU work, so platforms with
// a free CPU host win the comparison.
const GPU_RESERVED_PENALTY = 25;
const GPU_RESERVED_FALLBACK_REASON =
  "only GPU hosts are online — using one because no non-GPU host is available";
const GPU_RESERVED_PREFERENCE_REASON = "non-GPU host preferred — GPU hosts are kept free for GPU workloads";

// ─── Platform scorers ─────────────────────────────────────────────────────────

function scoreDocker(
  reqs: PlacementRequirements,
  status: DockerStatus
): PlatformScore {
  const platform: PlatformTarget = { type: "docker" };

  if (!status.connected) {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "Docker daemon not reachable",
    };
  }

  if (reqs.gpu?.required && !status.gpuAvailable) {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "GPU required but nvidia-container-runtime not available on Docker host",
    };
  }

  if (reqs.type === "nanoclaw") {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "nanoclaw spawns its own containers — must run on Proxmox (VM/LXC), not inside Docker",
    };
  }

  let score = 0;
  const reasons: string[] = [];

  // GPU fit (30 pts)
  if (reqs.gpu?.required && status.gpuAvailable) {
    score += 30;
    reasons.push("GPU available via container runtime passthrough");
  }

  // Keep the local GPU host free for GPU work when other platforms can take this one.
  if (!reqs.gpu?.required && status.gpuAvailable) {
    score -= GPU_RESERVED_PENALTY;
    reasons.push("Docker host has a GPU — kept free for GPU workloads unless nothing else is available");
  }

  // Type affinity (0–30 pts)
  const affinity = DOCKER_AFFINITY[reqs.type] ?? 15;
  score += affinity;
  if (affinity >= 25) {
    reasons.push(`${reqs.type} is well-suited for local Docker containers`);
  } else if (affinity >= 15) {
    reasons.push("compatible with Docker");
  }

  score += architectureScore(status.architecture);
  const archReason = architectureReason(status.architecture);
  if (archReason) reasons.push(archReason);

  // Persistence fit (±15 pts)
  if (reqs.persistent) {
    score -= 15;
    reasons.push("persistent agents prefer named volumes (Portainer) or VMs (Proxmox) over ephemeral containers");
  } else {
    score += 15;
    reasons.push("ephemeral workload — Docker offers fastest cold start");
  }

  // Resource headroom (0–10 pts) — fewer running containers = more capacity
  const running = status.containers.running;
  const headroom = Math.max(0, 10 - running * 2);
  score += headroom;
  if (running < 4) {
    reasons.push(`${running} containers running — plenty of headroom`);
  } else if (running >= 8) {
    reasons.push(`${running} containers running — host is under load`);
  }

  // Heavy resource request penalty (large jobs belong on managed platforms)
  if (reqs.resources.memoryMb >= 8192) {
    score -= 10;
    reasons.push("large memory request — consider Portainer or Proxmox for better isolation");
  }

  return { platform, score: Math.max(0, score), available: true, reasons };
}

function scorePortainer(
  reqs: PlacementRequirements,
  status: PortainerStatus
): PlatformScore {
  const onlineEndpoints = status.connected
    ? status.endpoints.filter((e) => e.status === 1 && !e.excluded)
    : [];
  const gpuEndpoints = onlineEndpoints.filter((e) => e.gpuAvailable);

  // Pick the best endpoint: architecture first, then fewest running containers (most headroom)
  function sortEndpoints<T extends { architecture?: import("./types/platform.js").PlatformArchitecture; runningContainers?: number }>(
    list: T[]
  ): T[] {
    return list.slice().sort((a, b) => {
      const archDiff = architectureScore(b.architecture) - architectureScore(a.architecture);
      if (archDiff !== 0) return archDiff;
      return (a.runningContainers ?? 0) - (b.runningContainers ?? 0);
    });
  }

  const endpointPool = selectHostPool(onlineEndpoints, gpuEndpoints, reqs.gpu?.required ?? false);
  const targetEndpoint = sortEndpoints(endpointPool.pool)[0];

  const platform: PlatformTarget = {
    type: "portainer",
    endpointId: targetEndpoint?.id ?? 1,
    ...(targetEndpoint?.name ? { endpointName: targetEndpoint.name } : {}),
  };

  if (!status.connected) {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "Portainer API not reachable",
    };
  }

  if (onlineEndpoints.length === 0) {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "No Portainer endpoints online",
    };
  }

  if (reqs.gpu?.required && gpuEndpoints.length === 0) {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "GPU required but no GPU-capable Portainer endpoints available",
    };
  }

  if (reqs.type === "nanoclaw") {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "nanoclaw spawns its own containers — must run on Proxmox (VM/LXC), not inside Portainer",
    };
  }

  let score = 0;
  const reasons: string[] = [];

  // GPU fit (30 pts)
  if (reqs.gpu?.required && gpuEndpoints.length > 0) {
    score += 30;
    reasons.push(`GPU available on endpoint "${gpuEndpoints[0]!.name}"`);
  }

  // Endpoint count bonus — more endpoints = more scheduling flexibility
  score += Math.min(10, onlineEndpoints.length * 4);
  reasons.push(
    onlineEndpoints.length > 1
      ? `${onlineEndpoints.length} endpoints online — flexible placement`
      : `endpoint "${onlineEndpoints[0]!.name}" online`
  );

  // Container headroom (0–10 pts) — fewer running containers = more capacity
  if (targetEndpoint?.runningContainers !== undefined) {
    const running = targetEndpoint.runningContainers;
    const headroom = Math.max(0, 10 - running * 2);
    score += headroom;
    if (running < 4) {
      reasons.push(`${running} containers running on "${targetEndpoint.name}" — plenty of headroom`);
    } else if (running >= 8) {
      reasons.push(`"${targetEndpoint.name}" is under load (${running} containers running)`);
    }
  }

  // Type affinity (0–25 pts)
  const affinity = PORTAINER_AFFINITY[reqs.type] ?? 15;
  score += affinity;

  score += architectureScore(targetEndpoint?.architecture);
  const archReason = architectureReason(targetEndpoint?.architecture);
  if (archReason && targetEndpoint) {
    reasons.push(`${archReason} on endpoint "${targetEndpoint.name}"`);
  }

  // Persistence fit (0–20 pts) — Portainer supports named containers/stacks
  if (reqs.persistent) {
    score += 20;
    reasons.push("persistent — Portainer stacks maintain named volumes across restarts");
  }

  // Heavy resource request bonus — Portainer handles large containers better
  if (reqs.resources.memoryMb >= 8192) {
    score += 8;
    reasons.push("large memory request — Portainer provides better resource management");
  }

  if (!reqs.gpu?.required) {
    if (endpointPool.usingReservedGpuHost) {
      score -= GPU_RESERVED_PENALTY;
      reasons.push(GPU_RESERVED_FALLBACK_REASON);
    } else if (gpuEndpoints.length > 0) reasons.push(GPU_RESERVED_PREFERENCE_REASON);
  }

  return { platform, score: Math.max(0, score), available: true, reasons };
}

function scoreProxmox(
  reqs: PlacementRequirements,
  status: ProxmoxStatus
): PlatformScore {
  const onlineNodes = status.connected
    ? status.nodes.filter((n) => n.status === "online" && !n.excluded)
    : [];
  const gpuNodes = onlineNodes.filter((n) => (n.gpuCount ?? 0) > 0);

  // Find the best-fit node: most free memory, GPU if needed
  const nodePool = selectHostPool(onlineNodes, gpuNodes, reqs.gpu?.required ?? false);
  const targetNode = nodePool.pool
    .slice()
    .sort(
      (a, b) =>
        architectureScore(b.architecture) - architectureScore(a.architecture) ||
        b.memoryTotal - b.memoryUsed - (a.memoryTotal - a.memoryUsed)
    )[0];

  const platform: PlatformTarget = {
    type: "proxmox",
    node: targetNode?.name ?? "pve-01",
    vmType: reqs.gpu?.passthroughMode === "vm" || reqs.gpu?.required ? "qemu" : "lxc",
  };

  if (!status.connected) {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "Proxmox API not reachable",
    };
  }

  if (onlineNodes.length === 0) {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "No Proxmox nodes online",
    };
  }

  if (reqs.gpu?.required && gpuNodes.length === 0) {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "GPU required but no nodes have available GPUs for passthrough",
    };
  }

  let score = 0;
  const reasons: string[] = [];

  // GPU fit (40 pts — VM passthrough is the strongest GPU isolation option)
  if (reqs.gpu?.required && gpuNodes.length > 0) {
    score += 40;
    reasons.push(
      `GPU passthrough via VM on node "${targetNode!.name}" (${gpuNodes[0]!.gpuCount} device${(gpuNodes[0]!.gpuCount ?? 1) > 1 ? "s" : ""})`
    );
  }

  // Type affinity (0–30 pts)
  const affinity = PROXMOX_AFFINITY[reqs.type] ?? 10;
  score += affinity;
  if (affinity >= 20) {
    reasons.push(`${reqs.type} benefits from dedicated VM isolation`);
  }

  score += architectureScore(targetNode?.architecture);
  const archReason = architectureReason(targetNode?.architecture);
  if (archReason && targetNode) {
    reasons.push(`${archReason} on node "${targetNode.name}"`);
  }

  // Persistence fit (0–25 pts) — VMs/LXCs are first-class persistent citizens
  if (reqs.persistent) {
    score += 25;
    reasons.push("persistent — VM/LXC provides full OS-level persistence and network identity");
  } else {
    // Ephemeral penalty — spinning up a VM for a short job is wasteful
    score -= 20;
    reasons.push("ephemeral workload — VM startup overhead not justified; use Docker or Portainer");
  }

  // Resource headroom (0–15 pts)
  if (targetNode) {
    const freeRatio = 1 - targetNode.memoryUsed / Math.max(1, targetNode.memoryTotal);
    const headroomPts = Math.round(freeRatio * 15);
    score += headroomPts;
    const freeMb = targetNode.memoryTotal - targetNode.memoryUsed;
    if (freeRatio > 0.5) {
      reasons.push(`${Math.round(freeMb / 1024)}GB free on node "${targetNode.name}"`);
    } else if (freeRatio < 0.2) {
      reasons.push(`node "${targetNode.name}" is under memory pressure`);
    }
  }

  // Heavy resource bonus — large workloads belong on dedicated infrastructure
  if (reqs.resources.memoryMb >= 16384) {
    score += 10;
    reasons.push("large workload — dedicated VM/LXC provides better isolation");
  }

  if (!reqs.gpu?.required) {
    if (nodePool.usingReservedGpuHost) {
      score -= GPU_RESERVED_PENALTY;
      reasons.push(GPU_RESERVED_FALLBACK_REASON);
    } else if (gpuNodes.length > 0) reasons.push(GPU_RESERVED_PREFERENCE_REASON);
  }

  return { platform, score: Math.max(0, score), available: true, reasons };
}

function scoreKomodo(
  reqs: PlacementRequirements,
  status: KomodoStatus
): PlatformScore {
  const onlineServers = status.connected
    ? status.servers.filter((s) => s.state === "ok" && !s.excluded)
    : [];
  const gpuServers = onlineServers.filter((s) => s.gpuAvailable);

  // Best-fit server: architecture first, then most free memory
  const serverPool = selectHostPool(onlineServers, gpuServers, reqs.gpu?.required ?? false);
  const targetServer = serverPool.pool
    .slice()
    .sort(
      (a, b) =>
        architectureScore(b.architecture) - architectureScore(a.architecture) ||
        (b.totalMemoryGb ?? 0) - (b.usedMemoryGb ?? 0) - ((a.totalMemoryGb ?? 0) - (a.usedMemoryGb ?? 0))
    )[0];

  const platform: PlatformTarget = {
    type: "komodo",
    serverId: targetServer?.id ?? "",
    ...(targetServer?.name ? { serverName: targetServer.name } : {}),
  };

  if (!status.connected) {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "Komodo core not reachable",
    };
  }

  if (onlineServers.length === 0) {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "No Komodo servers online",
    };
  }

  if (reqs.gpu?.required && gpuServers.length === 0) {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "GPU required but no GPU-capable Komodo servers available",
    };
  }

  if (reqs.type === "nanoclaw") {
    return {
      platform,
      score: 0,
      available: false,
      reasons: [],
      disqualifyReason: "nanoclaw spawns its own containers — must run on Proxmox (VM/LXC), not inside a Komodo-managed Docker host",
    };
  }

  let score = 0;
  const reasons: string[] = [];

  // GPU fit (30 pts)
  if (reqs.gpu?.required && gpuServers.length > 0) {
    score += 30;
    const g = gpuServers[0]!;
    reasons.push(`GPU available on server "${g.name}"${g.gpuModel ? ` (${g.gpuModel})` : ""}`);
  }

  // Type affinity (0–25 pts)
  const affinity = KOMODO_AFFINITY[reqs.type] ?? 15;
  score += affinity;
  if (affinity >= 25) {
    reasons.push(`${reqs.type} is well-suited for Komodo-managed deployments`);
  }

  // Server count bonus — more servers = more scheduling flexibility
  score += Math.min(8, onlineServers.length * 2);

  // Memory headroom (0–12 pts) — most free memory wins
  if (targetServer && targetServer.totalMemoryGb) {
    const freeGb = targetServer.totalMemoryGb - (targetServer.usedMemoryGb ?? 0);
    const freeRatio = freeGb / targetServer.totalMemoryGb;
    score += Math.round(Math.max(0, Math.min(1, freeRatio)) * 12);
    if (freeRatio > 0.5) {
      reasons.push(`${Math.round(freeGb)}GB free on "${targetServer.name}"`);
    } else if (freeRatio < 0.2) {
      reasons.push(`"${targetServer.name}" is under memory pressure`);
    }
  }

  score += architectureScore(targetServer?.architecture);
  const archReason = architectureReason(targetServer?.architecture);
  if (archReason && targetServer) {
    reasons.push(`${archReason} on "${targetServer.name}"`);
  }

  // Persistence fit (0–20 pts) — Komodo deployments are named, versioned resources
  if (reqs.persistent) {
    score += 20;
    reasons.push("persistent — Komodo deployments are named resources with lifecycle management");
  }

  if (!reqs.gpu?.required) {
    if (serverPool.usingReservedGpuHost) {
      score -= GPU_RESERVED_PENALTY;
      reasons.push(GPU_RESERVED_FALLBACK_REASON);
    } else if (gpuServers.length > 0) reasons.push(GPU_RESERVED_PREFERENCE_REASON);
  }

  return { platform, score: Math.max(0, score), available: true, reasons };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Score all available platforms and return a placement decision.
 *
 * @param reqs - What the agent needs
 * @param ctx  - Current status of each platform (null = not configured)
 */
export function scheduleAgent(
  reqs: PlacementRequirements,
  ctx: SchedulerContext
): PlacementDecision {
  const scores: PlatformScore[] = [];

  // A platform the server reports as not configured here is not a candidate at all.
  if (ctx.docker && ctx.docker.configured !== false) scores.push(scoreDocker(reqs, ctx.docker));
  if (ctx.portainer && ctx.portainer.configured !== false) scores.push(scorePortainer(reqs, ctx.portainer));
  if (ctx.proxmox && ctx.proxmox.configured !== false) scores.push(scoreProxmox(reqs, ctx.proxmox));
  if (ctx.komodo && ctx.komodo.configured !== false) scores.push(scoreKomodo(reqs, ctx.komodo));

  if (scores.length === 0) {
    return {
      outcome: "no-platforms",
      scores: [],
      summary: "No platforms configured — configure Docker, Portainer, Komodo or Proxmox",
    };
  }

  // Sort: available first, then by score descending
  const sorted = scores.slice().sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return b.score - a.score;
  });

  const winner = sorted[0];

  if (!winner?.available) {
    const needsGpu = reqs.gpu?.required ?? false;
    return {
      outcome: needsGpu ? "queued" : "no-platforms",
      scores: sorted,
      summary: needsGpu
        ? "No GPU-capable platforms available — will retry when one comes online"
        : "All configured platforms are unavailable",
    };
  }

  const platformLabel =
    winner.platform.type === "docker"
      ? "Docker"
      : winner.platform.type === "portainer"
      ? `Portainer (${(winner.platform as { endpointName?: string; endpointId: number }).endpointName ?? `endpoint ${(winner.platform as { endpointId: number }).endpointId}`})`
      : winner.platform.type === "proxmox"
      ? `Proxmox (${(winner.platform as { node: string; vmType: string }).node} / ${(winner.platform as { vmType: string }).vmType})`
      : `Komodo (${(winner.platform as { serverName?: string; serverId: string }).serverName ?? (winner.platform as { serverId: string }).serverId})`;

  return {
    outcome: "scheduled",
    placement: winner.platform,
    winner,
    scores: sorted,
    summary: `Scheduled on ${platformLabel} — score ${winner.score}`,
  };
}
