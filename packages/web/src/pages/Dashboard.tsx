import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentState, AgentStatus } from "@devlet/shared";
import { MOCK_AGENTS } from "../mocks/agents.js";
import { AgentCard } from "../components/AgentCard.js";
import { ConfirmModal } from "../components/ConfirmModal.js";

const STATUS_FILTERS: { label: string; value: AgentStatus | "all" }[] = [
  { label: "all", value: "all" },
  { label: "running", value: "running" },
  { label: "bootstrapping", value: "bootstrapping" },
  { label: "idle", value: "idle" },
  { label: "error", value: "error" },
  { label: "terminated", value: "terminated" },
];

export function Dashboard() {
  const navigate = useNavigate();
  const [agents] = useState<AgentState[]>(MOCK_AGENTS);
  const [filter, setFilter] = useState<AgentStatus | "all">("all");
  const [fireTarget, setFireTarget] = useState<string | null>(null);

  const filtered =
    filter === "all" ? agents : agents.filter((a) => a.status === filter);

  const counts = agents.reduce(
    (acc, a) => {
      acc[a.status] = (acc[a.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  function handleFire(id: string) {
    setFireTarget(id);
  }

  function confirmFire() {
    // TODO: call trpc.agents.fire.useMutation()
    console.log("fire", fireTarget);
    setFireTarget(null);
  }

  const targetAgent = agents.find((a) => a.config.id === fireTarget);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-surface-border px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="mono-header text-xl text-accent-cyan tracking-tight">
            DEVLET
          </h1>
          <div className="text-[11px] text-gray-600 mt-0.5">
            agent control / mission dispatch
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Stat pills */}
          <div className="flex gap-2 text-[11px]">
            <span className="px-2 py-0.5 rounded-sm bg-status-running/10 text-status-running border border-status-running/20">
              {counts["running"] ?? 0} running
            </span>
            <span className="px-2 py-0.5 rounded-sm bg-status-error/10 text-status-error border border-status-error/20">
              {counts["error"] ?? 0} error
            </span>
          </div>
          <button
            className="btn-primary"
            onClick={() => navigate("/hire")}
          >
            + hire agent
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="border-b border-surface-border px-6 py-2 flex items-center gap-1">
        {STATUS_FILTERS.map(({ label, value }) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={`px-2.5 py-1 text-[11px] rounded-sm border transition-colors ${
              filter === value
                ? "bg-accent-cyan/10 border-accent-cyan/40 text-accent-cyan"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {label}
            {value !== "all" && counts[value] !== undefined && (
              <span className="ml-1 opacity-60">{counts[value]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Agent grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-600">
            <div className="text-4xl mb-3 opacity-20">◻</div>
            <div className="text-sm">no agents</div>
            <button
              className="btn-primary mt-4"
              onClick={() => navigate("/hire")}
            >
              hire your first agent
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map((agent) => (
              <AgentCard
                key={agent.config.id}
                agent={agent}
                onFire={handleFire}
              />
            ))}
          </div>
        )}
      </div>

      {/* Fire confirmation modal */}
      {fireTarget && targetAgent && (
        <ConfirmModal
          title="Fire agent?"
          message={`"${targetAgent.config.name}" will be terminated and its container destroyed. Mission state will be preserved in ~/.devlet/agents/.`}
          confirmLabel="fire"
          danger
          onConfirm={confirmFire}
          onCancel={() => setFireTarget(null)}
        />
      )}
    </div>
  );
}
