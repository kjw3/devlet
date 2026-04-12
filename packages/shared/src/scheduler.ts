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
 * preference order: docker > portainer > proxmox.
 */

import type { AgentType } from "./types/agent.js";
import type {
  DockerStatus,
  PortainerStatus,
  ProxmoxStatus,
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
  "hermes": 30,       // Smallest, most ephemeral — Docker is the natural home
  "claude-code": 25,  // Lightweight code agent — fast local container
  "codex": 25,        // Same as claude-code
  "openclaw": 15,     // General purpose — fine on Docker, better on Portainer
  "nemoclaw": 5,      // GPU-heavy NLP — Docker last resort (no passthrough by default)
};

const PORTAINER_AFFINITY: Record<AgentType, number> = {
  "openclaw": 25,     // Multi-instance, managed — Portainer is ideal
  "hermes": 20,       // Managed orchestration suits Hermes pipelines
  "claude-code": 15,  // Fine on Portainer if Docker is busy
  "codex": 15,
  "nemoclaw": 10,     // Can use container GPU passthrough
};

const PROXMOX_AFFINITY: Record<AgentType, number> = {
  "nemoclaw": 30,     // GPU passthrough, isolated VM — perfect for heavy NLP
  "openclaw": 20,     // Can run well in an LXC
  "claude-code": 10,  // Works, but overkill for a code agent
  "codex": 10,
  "hermes": 5,        // Proxmox is too heavy for a lightweight dispatcher
};

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

  let score = 0;
  const reasons: string[] = [];

  // GPU fit (30 pts)
  if (reqs.gpu?.required && status.gpuAvailable) {
    score += 30;
    reasons.push("GPU available via container runtime passthrough");
  }

  // Type affinity (0–30 pts)
  const affinity = DOCKER_AFFINITY[reqs.type] ?? 15;
  score += affinity;
  if (affinity >= 25) {
    reasons.push(`${reqs.type} is well-suited for local Docker containers`);
  } else if (affinity >= 15) {
    reasons.push("compatible with Docker");
  }

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
    ? status.endpoints.filter((e) => e.status === 1)
    : [];
  const gpuEndpoints = onlineEndpoints.filter((e) => e.gpuAvailable);

  // Pick the best endpoint for this workload
  const targetEndpoint =
    reqs.gpu?.required
      ? gpuEndpoints[0]
      : onlineEndpoints[0];

  const platform: PlatformTarget = {
    type: "portainer",
    endpointId: targetEndpoint?.id ?? 1,
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

  // Type affinity (0–25 pts)
  const affinity = PORTAINER_AFFINITY[reqs.type] ?? 15;
  score += affinity;

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

  return { platform, score: Math.max(0, score), available: true, reasons };
}

function scoreProxmox(
  reqs: PlacementRequirements,
  status: ProxmoxStatus
): PlatformScore {
  const onlineNodes = status.connected
    ? status.nodes.filter((n) => n.status === "online")
    : [];
  const gpuNodes = onlineNodes.filter((n) => (n.gpuCount ?? 0) > 0);

  // Find the best-fit node: most free memory, GPU if needed
  const candidateNodes = reqs.gpu?.required ? gpuNodes : onlineNodes;
  const targetNode = candidateNodes
    .slice()
    .sort(
      (a, b) =>
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

  if (ctx.docker) scores.push(scoreDocker(reqs, ctx.docker));
  if (ctx.portainer) scores.push(scorePortainer(reqs, ctx.portainer));
  if (ctx.proxmox) scores.push(scoreProxmox(reqs, ctx.proxmox));

  if (scores.length === 0) {
    return {
      outcome: "no-platforms",
      scores: [],
      summary: "No platforms configured — add Docker, Portainer, or Proxmox in settings",
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
      ? `Portainer (endpoint ${(winner.platform as { endpointId: number }).endpointId})`
      : `Proxmox (${(winner.platform as { node: string; vmType: string }).node} / ${(winner.platform as { vmType: string }).vmType})`;

  return {
    outcome: "scheduled",
    placement: winner.platform,
    winner,
    scores: sorted,
    summary: `Scheduled on ${platformLabel} — score ${winner.score}`,
  };
}
