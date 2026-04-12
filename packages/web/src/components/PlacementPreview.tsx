import { useState } from "react";
import { scheduleAgent } from "@devlet/shared";
import type {
  PlacementRequirements,
  PlacementDecision,
  PlatformScore,
  PlatformTarget,
} from "@devlet/shared";
import {
  MOCK_DOCKER_STATUS,
  MOCK_PORTAINER_STATUS,
  MOCK_PROXMOX_STATUS,
} from "../mocks/platforms.js";

const PLATFORM_LABELS: Record<string, string> = {
  docker: "Docker",
  portainer: "Portainer",
  proxmox: "Proxmox",
};

function platformLabel(p: PlatformTarget): string {
  if (p.type === "portainer") return `Portainer / endpoint ${p.endpointId}`;
  if (p.type === "proxmox") return `Proxmox / ${p.node} (${p.vmType})`;
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

interface AlternativeRowProps {
  score: PlatformScore;
  onSelect: (p: PlatformTarget) => void;
}

function AlternativeRow({ score, onSelect }: AlternativeRowProps) {
  return (
    <div
      className={`flex items-center justify-between py-2 px-3 rounded-sm text-[11px] border ${
        score.available
          ? "border-surface-border hover:border-gray-600 cursor-pointer"
          : "border-transparent opacity-40 cursor-not-allowed"
      }`}
      onClick={() => score.available && onSelect(score.platform)}
    >
      <div className="flex items-center gap-2">
        <span
          className={`status-dot ${
            score.available ? "bg-gray-500" : "bg-status-error"
          }`}
        />
        <span className="text-gray-400">{platformLabel(score.platform)}</span>
        {!score.available && score.disqualifyReason && (
          <span className="text-gray-600 italic">— {score.disqualifyReason}</span>
        )}
      </div>
      {score.available ? (
        <ScoreBar score={score.score} />
      ) : (
        <span className="text-[10px] text-gray-700 uppercase tracking-wider">unavailable</span>
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
}

export function PlacementPreview({
  requirements,
  onPlacement,
  override,
}: PlacementPreviewProps) {
  const [showOverrides, setShowOverrides] = useState(false);

  const decision: PlacementDecision = scheduleAgent(requirements, {
    docker: MOCK_DOCKER_STATUS,
    portainer: MOCK_PORTAINER_STATUS,
    proxmox: MOCK_PROXMOX_STATUS,
  });

  const effective = override ?? decision.placement;
  const effectiveLabel = effective ? platformLabel(effective) : "none";
  const isOverridden = override !== undefined;

  const alternatives = decision.scores.filter(
    (s) => s.platform.type !== decision.winner?.platform.type
  );

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
        <div className="flex items-center gap-2 pt-2 border-t border-surface-border">
          {isOverridden ? (
            <button
              className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
              onClick={() => {
                onPlacement(undefined);
                setShowOverrides(false);
              }}
            >
              ← use recommendation ({decision.winner ? platformLabel(decision.winner.platform) : "auto"})
            </button>
          ) : (
            <button
              className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
              onClick={() => setShowOverrides((v) => !v)}
            >
              {showOverrides ? "hide alternatives ↑" : "override placement ↓"}
            </button>
          )}
        </div>
      </div>

      {/* Alternatives (shown on expand) */}
      {showOverrides && !isOverridden && alternatives.length > 0 && (
        <div className="card p-3 space-y-1">
          <div className="label mb-2">alternatives</div>
          {alternatives.map((s, i) => (
            <AlternativeRow
              key={i}
              score={s}
              onSelect={(p) => {
                onPlacement(p);
                setShowOverrides(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
