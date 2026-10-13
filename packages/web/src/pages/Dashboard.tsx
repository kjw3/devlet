import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { trpc } from "../trpc.js";
import { AgentCard } from "../components/AgentCard.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import {
  LIFECYCLE_LABEL,
  LIFECYCLE_ORDER,
  kindOf,
  lifecycleOf,
  sortByLifecycle,
  type AgentKind,
  type Lifecycle,
} from "../lib/lifecycle.js";

const KIND_FILTERS: { label: string; value: AgentKind | "all" }[] = [
  { label: "all", value: "all" },
  { label: "long-running", value: "long-running" },
  { label: "tasks", value: "task" },
];

// Chip accent per lifecycle group (matches the status dot colours).
const LIFECYCLE_ACCENT: Record<Lifecycle, string> = {
  attention: "bg-status-error/10 border-status-error/40 text-status-error",
  starting: "bg-status-provisioning/10 border-status-provisioning/40 text-status-provisioning",
  running: "bg-status-running/10 border-status-running/40 text-status-running",
  stopped: "bg-surface-border/40 border-surface-border text-gray-300",
};

export function Dashboard() {
  const navigate = useNavigate();
  // Filters live in the URL so a refresh or a shared link keeps the same view.
  const [params, setParams] = useSearchParams();
  const lifecycleParam = params.get("state");
  const lifecycle: Lifecycle | "all" = LIFECYCLE_ORDER.includes(lifecycleParam as Lifecycle)
    ? (lifecycleParam as Lifecycle)
    : "all";
  const kindParam = params.get("kind");
  const kind: AgentKind | "all" = kindParam === "task" || kindParam === "long-running" ? kindParam : "all";

  const setFilter = (key: "state" | "kind", value: string) => {
    const next = new URLSearchParams(params);
    if (value === "all") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  const [fireTarget, setFireTarget] = useState<string | null>(null);

  const { data: agents = [], isLoading, error } = trpc.agents.list.useQuery(
    undefined,
    { refetchInterval: 5_000 }
  );

  const utils = trpc.useUtils();
  const fireMutation = trpc.agents.fire.useMutation({
    onSuccess: () => {
      void utils.agents.list.invalidate();
      setFireTarget(null);
    },
  });
  const deleteMutation = trpc.agents.delete.useMutation({
    onSuccess: () => void utils.agents.list.invalidate(),
  });
  const restartMutation = trpc.agents.restart.useMutation({
    onSuccess: () => void utils.agents.list.invalidate(),
  });
  const recoverMutation = trpc.agents.recover.useMutation({
    onSuccess: () => void utils.agents.list.invalidate(),
  });

  // Each filter's counts respect the other filter, so the chips always add up to what is shown.
  const byKind = kind === "all" ? agents : agents.filter((a) => kindOf(a) === kind);
  const byLifecycle =
    lifecycle === "all" ? agents : agents.filter((a) => lifecycleOf(a.status) === lifecycle);

  const filtered = sortByLifecycle(
    byKind.filter((a) => lifecycle === "all" || lifecycleOf(a.status) === lifecycle)
  );

  const lifecycleCounts = byKind.reduce(
    (acc, a) => {
      const group = lifecycleOf(a.status);
      acc[group] = (acc[group] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<Lifecycle, number>>
  );
  const kindCounts = byLifecycle.reduce(
    (acc, a) => {
      const k = kindOf(a);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<AgentKind, number>>
  );

  // Header summary is always fleet-wide.
  const fleet = agents.reduce(
    (acc, a) => {
      const group = lifecycleOf(a.status);
      acc[group] = (acc[group] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<Lifecycle, number>>
  );
  const filtersActive = lifecycle !== "all" || kind !== "all";

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
          <div className="flex gap-2 text-[11px]">
            <span className="px-2 py-0.5 rounded-sm bg-status-running/10 text-status-running border border-status-running/20">
              {fleet.running ?? 0} running
            </span>
            {(fleet.starting ?? 0) > 0 && (
              <span className="px-2 py-0.5 rounded-sm bg-status-provisioning/10 text-status-provisioning border border-status-provisioning/20">
                {fleet.starting} starting
              </span>
            )}
            {(fleet.attention ?? 0) > 0 && (
              <span className="px-2 py-0.5 rounded-sm bg-status-error/10 text-status-error border border-status-error/20">
                {fleet.attention} need attention
              </span>
            )}
          </div>
          <button className="btn-primary" onClick={() => navigate("/hire")}>
            + hire agent
          </button>
        </div>
      </div>

      {/* Filter bar: lifecycle stage, then kind */}
      <div className="border-b border-surface-border px-6 py-2 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-1" role="group" aria-label="Filter by lifecycle">
          <FilterChip
            active={lifecycle === "all"}
            onClick={() => setFilter("state", "all")}
            label="all"
            count={byKind.length}
          />
          {LIFECYCLE_ORDER.map((group) => (
            <FilterChip
              key={group}
              active={lifecycle === group}
              accent={LIFECYCLE_ACCENT[group]}
              onClick={() => setFilter("state", group)}
              label={LIFECYCLE_LABEL[group]}
              count={lifecycleCounts[group] ?? 0}
            />
          ))}
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Filter by kind">
          <span className="text-[10px] uppercase tracking-wider text-gray-600 mr-1">kind</span>
          {KIND_FILTERS.map(({ label, value }) => (
            <FilterChip
              key={value}
              active={kind === value}
              onClick={() => setFilter("kind", value)}
              label={label}
              count={value === "all" ? byLifecycle.length : kindCounts[value] ?? 0}
            />
          ))}
        </div>
      </div>

      {/* Agent grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="text-center text-accent-red text-[12px] py-8">
            could not reach server — is devlet-server running?
            <div className="text-gray-600 text-[11px] mt-1">{error.message}</div>
          </div>
        )}

        {isLoading && !error && (
          <div className="text-center text-gray-600 text-[12px] py-8 animate-pulse">
            connecting to server...
          </div>
        )}

        {!isLoading && !error && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-gray-600">
            <div className="text-4xl mb-3 opacity-20">◻</div>
            {filtersActive && agents.length > 0 ? (
              <>
                <div className="text-sm">no agents match these filters</div>
                <button
                  className="btn-ghost mt-4"
                  onClick={() => setParams(new URLSearchParams(), { replace: true })}
                >
                  clear filters
                </button>
              </>
            ) : (
              <>
                <div className="text-sm">no agents</div>
                <button className="btn-primary mt-4" onClick={() => navigate("/hire")}>
                  hire your first agent
                </button>
              </>
            )}
          </div>
        )}

        {!isLoading && !error && filtered.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map((agent) => (
              <AgentCard
                onDelete={(id) => deleteMutation.mutate(id)}
                onStart={(id) => restartMutation.mutate(id)}
                onRecover={(id) => recoverMutation.mutate({ agentId: id })}
                key={agent.config.id}
                agent={agent}
                onFire={(id) => setFireTarget(id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Fire confirmation */}
      {fireTarget && targetAgent && (
        <ConfirmModal
          title="Fire agent?"
          message={`"${targetAgent.config.name}" will be terminated and its container destroyed. Mission state will be preserved in ~/.devlet/agents/.`}
          confirmLabel={fireMutation.isPending ? "firing..." : "fire"}
          danger
          onConfirm={() => fireMutation.mutate(fireTarget)}
          onCancel={() => setFireTarget(null)}
        />
      )}
    </div>
  );
}

interface FilterChipProps {
  label: string;
  count: number;
  active: boolean;
  accent?: string;
  onClick: () => void;
}

function FilterChip({ label, count, active, accent, onClick }: FilterChipProps) {
  const activeStyle = accent ?? "bg-accent-cyan/10 border-accent-cyan/40 text-accent-cyan";
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`px-2.5 py-1 text-[11px] rounded-sm border transition-colors ${
        active
          ? activeStyle
          : `border-transparent hover:text-gray-300 ${count === 0 ? "text-gray-700" : "text-gray-500"}`
      }`}
    >
      {label}
      <span className="ml-1 opacity-60">{count}</span>
    </button>
  );
}
