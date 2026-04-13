import type { AgentState } from "@devlet/shared";
import { AGENT_TYPE_LABELS } from "@devlet/shared";
import { StatusDot, StatusBadge } from "./StatusDot.js";
import { useNavigate } from "react-router-dom";

interface AgentCardProps {
  agent: AgentState;
  onFire?: (id: string) => void;
  onDelete?: (id: string) => void;
}

const PLATFORM_LABELS = {
  docker: "Docker",
  portainer: "Portainer",
  proxmox: "Proxmox",
} as const;

function progressPct(agent: AgentState): number {
  const total = agent.config.mission.steps.length;
  if (total === 0) return 0;
  return Math.round((agent.missionProgress.completed.length / total) * 100);
}

export function AgentCard({ agent, onFire, onDelete }: AgentCardProps) {
  const navigate = useNavigate();
  const pct = progressPct(agent);
  const isActive = agent.status === "running" || agent.status === "bootstrapping";

  return (
    <div
      className="card p-4 flex flex-col gap-3 cursor-pointer hover:border-surface-border/80 hover:bg-surface-overlay transition-colors group"
      onClick={() => navigate(`/agents/${agent.config.id}`)}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <StatusDot status={agent.status} className="mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <div className="font-semibold text-sm text-gray-100 truncate">
              {agent.config.name}
            </div>
            <div className="text-[11px] text-gray-500 truncate">
              {agent.config.id}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="label border border-surface-border px-1.5 py-0.5 rounded-sm">
            {AGENT_TYPE_LABELS[agent.config.type]}
          </span>
          <span className="label border border-surface-border px-1.5 py-0.5 rounded-sm">
            {PLATFORM_LABELS[agent.config.platform.type]}
          </span>
        </div>
      </div>

      {/* Role */}
      <div className="text-[12px] text-gray-400 line-clamp-1">
        {agent.config.role}
      </div>

      {/* Mission */}
      <div className="text-[11px] text-gray-500 italic line-clamp-2 leading-relaxed">
        {agent.config.mission.description}
      </div>

      {/* Progress bar */}
      {isActive && (
        <div>
          <div className="flex justify-between items-center mb-1">
            <span className="label">mission progress</span>
            <span className="text-[10px] text-gray-500">{pct}%</span>
          </div>
          <div className="h-0.5 bg-surface-border rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-cyan rounded-full transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Error message */}
      {agent.status === "error" && agent.error && (
        <div className="text-[11px] text-accent-red bg-accent-red/5 border border-accent-red/20 rounded-sm px-2 py-1.5 leading-relaxed">
          {agent.error}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-1 border-t border-surface-border">
        <StatusBadge status={agent.status} />
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
          {agent.status !== "terminated" && (
            <button
              className="btn-danger text-[10px]"
              onClick={(e) => {
                e.stopPropagation();
                onFire?.(agent.config.id);
              }}
            >
              fire
            </button>
          )}
          {agent.status === "terminated" && (
            <button
              className="btn-danger text-[10px]"
              onClick={(e) => {
                e.stopPropagation();
                onDelete?.(agent.config.id);
              }}
            >
              delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
