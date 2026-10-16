import type {
  PlacementRequirements,
  PlacementDecision,
  PlatformTarget,
  PlatformType,
  SchedulerContext,
} from "@devlet/shared";
import { scheduleAgent } from "@devlet/shared";

const PLATFORM_LABELS: Record<PlatformType, string> = {
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
  /** Stable option key for the dropdown */
  key: string;
  name: string;
  available: boolean;
  gpu: boolean;
  /** Why it can't be picked (shown as a disabled dropdown option) */
  note?: string;
}

function sameTarget(a: PlatformTarget | undefined, b: PlatformTarget): boolean {
  if (!a || a.type !== b.type) return false;
  if (a.type === "portainer" && b.type === "portainer") return a.endpointId === b.endpointId;
  if (a.type === "komodo" && b.type === "komodo") return a.serverId === b.serverId;
  if (a.type === "proxmox" && b.type === "proxmox") return a.node === b.node;
  return true;
}

/** A platform with its selectable targets. Only configured (enabled) platforms are included. */
interface PlatformGroup {
  type: PlatformType;
  label: string;
  candidates: Candidate[];
}

function listPlatformGroups(ctx: SchedulerContext, reqs: PlacementRequirements): PlatformGroup[] {
  const needGpu = reqs.gpu?.required ?? false;
  const fit = (online: boolean, excluded: boolean | undefined, gpu: boolean): string | undefined =>
    !online ? "offline" : excluded ? "excluded" : needGpu && !gpu ? "no GPU" : undefined;
  const make = (c: Omit<Candidate, "available"> & { reason: string | undefined }): Candidate => {
    const { reason, ...rest } = c;
    return { ...rest, available: reason === undefined, ...(reason ? { note: reason } : {}) };
  };

  const groups: PlatformGroup[] = [];

  const docker = ctx.docker;
  // A platform with no status here or reported as not configured is hidden.
  if (docker && docker.configured !== false) {
    groups.push({
      type: "docker",
      label: PLATFORM_LABELS.docker,
      candidates: [
        make({
          platform: { type: "docker" },
          key: "docker",
          name: "local host",
          gpu: Boolean(docker.gpuAvailable),
          reason: fit(docker.connected, false, Boolean(docker.gpuAvailable)),
        }),
      ],
    });
  }

  const portainer = ctx.portainer;
  if (portainer && portainer.configured !== false) {
    groups.push({
      type: "portainer",
      label: PLATFORM_LABELS.portainer,
      candidates: portainer.endpoints.map((e) =>
        make({
          platform: { type: "portainer", endpointId: e.id, endpointName: e.name },
          key: `portainer:${e.id}`,
          name: e.name,
          gpu: Boolean(e.gpuAvailable),
          reason: fit(portainer.connected && e.status === 1, e.excluded, Boolean(e.gpuAvailable)),
        })
      ),
    });
  }

  const proxmox = ctx.proxmox;
  if (proxmox && proxmox.configured !== false) {
    const vmType = reqs.gpu?.passthroughMode === "vm" || needGpu ? "qemu" : "lxc";
    groups.push({
      type: "proxmox",
      label: PLATFORM_LABELS.proxmox,
      candidates: proxmox.nodes.map((n) =>
        make({
          platform: { type: "proxmox", node: n.name, vmType },
          key: `proxmox:${n.name}`,
          name: `${n.name} (${vmType})`,
          gpu: (n.gpuCount ?? 0) > 0,
          reason: fit(proxmox.connected && n.status === "online", n.excluded, (n.gpuCount ?? 0) > 0),
        })
      ),
    });
  }

  const komodo = ctx.komodo;
  if (komodo && komodo.configured !== false) {
    groups.push({
      type: "komodo",
      label: PLATFORM_LABELS.komodo,
      candidates: komodo.servers.map((sv) =>
        make({
          platform: { type: "komodo", serverId: sv.id, serverName: sv.name },
          key: `komodo:${sv.id}`,
          name: sv.name,
          gpu: Boolean(sv.gpuAvailable),
          reason: fit(komodo.connected && sv.state === "ok", sv.excluded, Boolean(sv.gpuAvailable)),
        })
      ),
    });
  }

  return groups;
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

const SELECT_CLASS =
  "bg-surface border border-surface-border text-gray-300 text-[11px] rounded-sm px-2 py-1 focus:outline-none focus:border-accent-cyan disabled:opacity-40 max-w-48";

export function PlacementPreview({
  requirements,
  onPlacement,
  override,
  context,
  loading,
}: PlacementPreviewProps) {
  const schedulerContext: SchedulerContext = {
    docker: context?.docker ?? null,
    portainer: context?.portainer ?? null,
    proxmox: context?.proxmox ?? null,
    komodo: context?.komodo ?? null,
  };

  const decision: PlacementDecision = scheduleAgent(requirements, schedulerContext);

  const groups = listPlatformGroups(schedulerContext, requirements);

  // Effective selection: the override when set, otherwise the recommendation.
  const effective = override ?? decision.placement;
  const effectiveGroup =
    effective !== undefined ? groups.find((g) => g.type === effective.type) : undefined;
  const isOverridden = override !== undefined;

  /**
   * Resolve the target dropdown's value for the selected platform: the active
   * override when it belongs to this platform, else the recommendation when it
   * does, else the first available target, else the first candidate.
   */
  function selectedCandidate(group: PlatformGroup | undefined): Candidate | undefined {
    if (!group) return undefined;
    if (override && override.type === group.type) {
      const hit = group.candidates.find((c) => sameTarget(override, c.platform));
      if (hit) return hit;
    }
    const recommended = group.candidates.find((c) => sameTarget(decision.placement, c.platform));
    if (recommended) return recommended;
    return group.candidates.find((c) => c.available) ?? group.candidates[0];
  }

  /** Changing either dropdown re-decides; landing back on the recommendation clears the override. */
  function pick(candidate: Candidate | undefined) {
    if (!candidate) return;
    if (sameTarget(decision.placement, candidate.platform)) onPlacement(undefined);
    else onPlacement(candidate.platform);
  }

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
    <div
      className={`card p-4 border transition-colors ${
        isOverridden
          ? "border-accent-amber/40 bg-accent-amber/5"
          : "border-accent-cyan/30 bg-accent-cyan/5"
      }`}
    >
      {/* Recommendation header */}
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <div className="label mb-1">
            {isOverridden ? "placement override" : "recommended placement"}
          </div>
          <div className="flex items-center gap-2">
            <span className="status-dot bg-status-running" />
            <span className="font-semibold text-[14px] text-gray-100">
              {effective ? platformLabel(effective) : "none"}
            </span>
            {isOverridden && (
              <span className="text-[10px] text-accent-amber border border-accent-amber/40 px-1.5 py-0.5 rounded-sm">
                override
              </span>
            )}
          </div>
        </div>
        {decision.winner && !isOverridden && <ScoreBar score={decision.winner.score} />}
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

      {/* Override dropdowns — default to the recommendation */}
      {groups.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-surface-border">
          <span className="label flex-shrink-0">platform</span>
          <select
            aria-label="Platform"
            className={`${SELECT_CLASS} w-32`}
            value={effectiveGroup?.type ?? ""}
            onChange={(e) => {
              const group = groups.find((g) => g.type === e.target.value);
              // Default the target to the recommendation within the platform,
              // falling back to the first available one.
              pick(selectedCandidate(group));
            }}
          >
            {groups.map((g) => (
              <option key={g.type} value={g.type}>
                {g.label} ({g.candidates.length})
              </option>
            ))}
          </select>

          <span className="label flex-shrink-0">target</span>
          <select
            aria-label="Target"
            className={`${SELECT_CLASS} flex-1 min-w-40`}
            value={effectiveGroup ? (selectedCandidate(effectiveGroup)?.key ?? "") : ""}
            onChange={(e) => {
              const group = effectiveGroup;
              if (!group) return;
              pick(group.candidates.find((c) => c.key === e.target.value));
            }}
          >
            {effectiveGroup?.candidates.map((c) => (
              <option key={c.key} value={c.key} disabled={!c.available}>
                {c.name}
                {c.gpu ? " · GPU" : ""}
                {c.note ? ` — ${c.note}` : ""}
              </option>
            ))}
          </select>

          {isOverridden && (
            <button
              className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors flex-shrink-0"
              onClick={() => onPlacement(undefined)}
            >
              ← recommendation
            </button>
          )}
        </div>
      )}
    </div>
  );
}
