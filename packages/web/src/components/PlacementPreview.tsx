import { useState } from "react";
import { scheduleAgent } from "@devlet/shared";
import type {
  PlacementRequirements,
  PlacementDecision,
  PlatformTarget,
  SchedulerContext,
} from "@devlet/shared";

const PLATFORM_LABELS: Record<string, string> = {
  docker: "Docker",
  portainer: "Portainer",
  proxmox: "Proxmox",
  komodo: "Komodo",
};

function platformLabel(p: PlatformTarget): string {
  if (p.type === "portainer") return `Portainer / ${p.endpointName ?? `endpoint ${p.endpointId}`}`;
  if (p.type === "proxmox") return `Proxmox / ${p.node} (${p.vmType})`;
  if (p.type === "komodo") return `Komodo / ${p.serverName ?? p.serverId}`;
  return "Docker";
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-20 bg-surface-border rounded-full overflow-hidden">
        <div
          className="h-full bg-accent-cyan rounded-full"
          style={{ width: `${Math.min(100, score)}%` }}
        />
      </div>
      <span className="text-[10px] text-gray-600 tabular-nums">{score}</span>
    </div>
  );
}

/** One concrete place an agent could go: a Docker host, Portainer endpoint, Komodo server or Proxmox node. */
interface Candidate {
  platform: PlatformTarget;
  group: string;
  name: string;
  available: boolean;
  gpu: boolean;
  /** Why it can't be picked (shown greyed out) */
  note?: string;
}

function sameTarget(a: PlatformTarget | undefined, b: PlatformTarget): boolean {
  if (!a || a.type !== b.type) return false;
  if (a.type === "portainer" && b.type === "portainer") return a.endpointId === b.endpointId;
  if (a.type === "komodo" && b.type === "komodo") return a.serverId === b.serverId;
  if (a.type === "proxmox" && b.type === "proxmox") return a.node === b.node;
  return true;
}

function listCandidates(
  ctx: SchedulerContext,
  reqs: PlacementRequirements,
  hidden: Set<string>
): Candidate[] {
  const needGpu = reqs.gpu?.required ?? false;
  const out: Candidate[] = [];
  const fit = (online: boolean, excluded: boolean | undefined, gpu: boolean): string | undefined =>
    !online ? "offline" : excluded ? "excluded" : needGpu && !gpu ? "no GPU" : undefined;
  const add = (c: Omit<Candidate, "available"> & { reason: string | undefined }) => {
    const { reason, ...rest } = c;
    out.push({ ...rest, available: reason === undefined, ...(reason ? { note: reason } : {}) });
  };

  if (!hidden.has("docker") && ctx.docker) {
    add({
      platform: { type: "docker" },
      group: "Docker",
      name: "local",
      gpu: Boolean(ctx.docker.gpuAvailable),
      reason: fit(ctx.docker.connected, false, Boolean(ctx.docker.gpuAvailable)),
    });
  }
  if (!hidden.has("portainer") && ctx.portainer) {
    for (const e of ctx.portainer.endpoints) {
      add({
        platform: { type: "portainer", endpointId: e.id, endpointName: e.name },
        group: "Portainer",
        name: e.name,
        gpu: Boolean(e.gpuAvailable),
        reason: fit(ctx.portainer.connected && e.status === 1, e.excluded, Boolean(e.gpuAvailable)),
      });
    }
  }
  if (!hidden.has("komodo") && ctx.komodo) {
    for (const sv of ctx.komodo.servers) {
      add({
        platform: { type: "komodo", serverId: sv.id, serverName: sv.name },
        group: "Komodo",
        name: sv.name,
        gpu: Boolean(sv.gpuAvailable),
        reason: fit(ctx.komodo.connected && sv.state === "ok", sv.excluded, Boolean(sv.gpuAvailable)),
      });
    }
  }
  if (!hidden.has("proxmox") && ctx.proxmox) {
    const vmType = reqs.gpu?.passthroughMode === "vm" || needGpu ? "qemu" : "lxc";
    for (const n of ctx.proxmox.nodes) {
      add({
        platform: { type: "proxmox", node: n.name, vmType },
        group: "Proxmox",
        name: n.name,
        gpu: (n.gpuCount ?? 0) > 0,
        reason: fit(ctx.proxmox.connected && n.status === "online", n.excluded, (n.gpuCount ?? 0) > 0),
      });
    }
  }
  return out;
}

interface CandidateRowProps {
  candidate: Candidate;
  selected: boolean;
  recommended: boolean;
  onSelect: (p: PlatformTarget) => void;
}

function CandidateRow({ candidate, selected, recommended, onSelect }: CandidateRowProps) {
  return (
    <div
      className={`flex items-center justify-between py-2 px-3 rounded-sm text-[11px] border ${
        selected
          ? "border-accent-amber/40 bg-accent-amber/5"
          : candidate.available
          ? "border-surface-border hover:border-gray-600 cursor-pointer"
          : "border-transparent opacity-40 cursor-not-allowed"
      }`}
      onClick={() => candidate.available && onSelect(candidate.platform)}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`status-dot flex-shrink-0 ${candidate.available ? "bg-status-running" : "bg-status-error"}`} />
        <span className="text-gray-400 truncate">{candidate.name}</span>
        {candidate.gpu && <span className="text-[9px] text-accent-purple">GPU</span>}
        {candidate.note && <span className="text-gray-600 italic">— {candidate.note}</span>}
      </div>
      {recommended && (
        <span className="text-[10px] text-accent-cyan uppercase tracking-wider flex-shrink-0">recommended</span>
      )}
    </div>
  );
}

interface PlacementPreviewProps {
  requirements: PlacementRequirements;
  /** Called when a placement is confirmed (auto or override) */
  onPlacement: (p: PlatformTarget | undefined) => void;
  /** Currently selected override, if any */
  override?: PlatformTarget;
  /** Live platform status from the server; a platform that is absent is not considered */
  context?: Partial<SchedulerContext>;
  /** Platform status is still being fetched, so no recommendation can be made yet */
  loading?: boolean;
}

export function PlacementPreview({
  requirements,
  onPlacement,
  override,
  context,
  loading,
}: PlacementPreviewProps) {
  const [showOverrides, setShowOverrides] = useState(false);

  // Hidden from placement options: platforms not yet fully implemented, plus any
  // the server reports as not configured in this deployment.
  const COMING_SOON_PLATFORM_TYPES = new Set<string>(["proxmox"]);
  for (const type of ["docker", "portainer", "proxmox", "komodo"] as const) {
    if (context?.[type]?.configured === false) COMING_SOON_PLATFORM_TYPES.add(type);
  }

  const schedulerContext: SchedulerContext = {
    docker: context?.docker ?? null,
    portainer: context?.portainer ?? null,
    proxmox: context?.proxmox ?? null,
    komodo: context?.komodo ?? null,
  };

  const decision: PlacementDecision = scheduleAgent(requirements, schedulerContext);

  // If the scheduler picked a coming-soon platform, suppress it.
  const effectivePlacement =
    decision.placement && COMING_SOON_PLATFORM_TYPES.has(decision.placement.type)
      ? undefined
      : decision.placement;

  const effective = override ?? effectivePlacement;
  const effectiveLabel = effective ? platformLabel(effective) : "none";
  const isOverridden = override !== undefined;

  const candidates = listCandidates(schedulerContext, requirements, COMING_SOON_PLATFORM_TYPES);
  const groups = [...new Set(candidates.map((c) => c.group))];

  if (loading) {
    return (
      <div className="card p-4">
        <div className="label animate-pulse">checking platforms…</div>
      </div>
    );
  }

  // Surface-level outcome display
  if (decision.outcome === "no-platforms") {
    return (
      <div className="card p-4 border-accent-red/30 bg-accent-red/5">
        <div className="label text-accent-red mb-2">no platforms available</div>
        <div className="text-[12px] text-gray-400">{decision.summary}</div>
      </div>
    );
  }

  if (decision.outcome === "queued") {
    return (
      <div className="card p-4 border-accent-amber/30 bg-accent-amber/5">
        <div className="label text-accent-amber mb-2">queued — waiting for GPU</div>
        <div className="text-[12px] text-gray-400">{decision.summary}</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Winner card */}
      <div
        className={`card p-4 border transition-colors ${
          isOverridden
            ? "border-accent-amber/40 bg-accent-amber/5"
            : "border-accent-cyan/30 bg-accent-cyan/5"
        }`}
      >
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <div className="label mb-1">
              {isOverridden ? "placement override" : "recommended placement"}
            </div>
            <div className="flex items-center gap-2">
              <span className="status-dot bg-status-running" />
              <span className="font-semibold text-[14px] text-gray-100">
                {effectiveLabel}
              </span>
              {isOverridden && (
                <span className="text-[10px] text-accent-amber border border-accent-amber/40 px-1.5 py-0.5 rounded-sm">
                  override
                </span>
              )}
            </div>
          </div>
          {decision.winner && !isOverridden && (
            <ScoreBar score={decision.winner.score} />
          )}
        </div>

        {/* Reasoning bullets */}
        {!isOverridden && decision.winner && decision.winner.reasons.length > 0 && (
          <ul className="space-y-1 mb-3">
            {decision.winner.reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11px] text-gray-400">
                <span className="text-accent-cyan mt-0.5 flex-shrink-0">·</span>
                {r}
              </li>
            ))}
          </ul>
        )}

        {/* Override controls */}
        <div className="flex items-center gap-4 pt-2 border-t border-surface-border">
          <button
            className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
            onClick={() => setShowOverrides((v) => !v)}
          >
            {showOverrides ? "hide servers ↑" : "choose server ↓"}
          </button>
          {isOverridden && (
            <button
              className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
              onClick={() => {
                onPlacement(undefined);
                setShowOverrides(false);
              }}
            >
              ← use recommendation ({decision.winner ? platformLabel(decision.winner.platform) : "auto"})
            </button>
          )}
        </div>
      </div>

      {/* Every server/endpoint/node, grouped by platform (shown on expand) */}
      {showOverrides && candidates.length > 0 && (
        <div className="card p-3 space-y-3">
          {groups.map((group) => (
            <div key={group} className="space-y-1">
              <div className="label mb-1">{group}</div>
              {candidates
                .filter((c) => c.group === group)
                .map((c) => (
                  <CandidateRow
                    key={`${group}:${c.name}`}
                    candidate={c}
                    selected={sameTarget(override, c.platform)}
                    recommended={!isOverridden && sameTarget(effectivePlacement, c.platform)}
                    onSelect={(p) => {
                      onPlacement(p);
                      setShowOverrides(false);
                    }}
                  />
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
