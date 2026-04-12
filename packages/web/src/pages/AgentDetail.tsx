import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { AgentState } from "@devlet/shared";
import { AGENT_TYPE_LABELS } from "@devlet/shared";
import { MOCK_AGENTS } from "../mocks/agents.js";
import { StatusBadge } from "../components/StatusDot.js";
import { LogViewer } from "../components/LogViewer.js";
import { ConfirmModal } from "../components/ConfirmModal.js";

const PLATFORM_LABELS = { docker: "Docker", portainer: "Portainer", proxmox: "Proxmox" };

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-1.5 border-b border-surface-border last:border-0">
      <span className="label w-28 flex-shrink-0 pt-0.5">{label}</span>
      <span className="text-[12px] text-gray-300 flex-1">{value}</span>
    </div>
  );
}

function MissionSteps({ agent }: { agent: AgentState }) {
  const { steps } = agent.config.mission;
  const { completed, currentStep } = agent.missionProgress;

  return (
    <div className="space-y-1">
      {steps.map((step, i) => {
        const isDone = completed.includes(i);
        const isCurrent = currentStep === i && !isDone;

        return (
          <div
            key={i}
            className={`flex items-center gap-2 text-[11px] py-1 px-2 rounded-sm ${
              isDone
                ? "text-gray-500"
                : isCurrent
                ? "bg-accent-cyan/5 border border-accent-cyan/20 text-accent-cyan"
                : "text-gray-500"
            }`}
          >
            <span className="font-mono text-[10px] w-4 text-center opacity-50">
              {isDone ? "✓" : isCurrent ? "▶" : String(i).padStart(2, "0")}
            </span>
            <span className="font-medium">{step.action}</span>
            {step.description && (
              <span className="opacity-60 ml-1">— {step.description}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [showFire, setShowFire] = useState(false);

  const agent = MOCK_AGENTS.find((a) => a.config.id === id);

  if (!agent) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        <div className="text-center">
          <div className="text-sm mb-2">agent not found</div>
          <button className="btn-ghost" onClick={() => navigate("/")}>
            ← back
          </button>
        </div>
      </div>
    );
  }

  const { config, status, missionProgress, logs, error } = agent;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-surface-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            className="text-gray-600 hover:text-gray-300 transition-colors text-sm"
            onClick={() => navigate("/")}
          >
            ←
          </button>
          <div>
            <div className="mono-header text-base text-gray-100">
              {config.name}
            </div>
            <div className="text-[11px] text-gray-500">{config.id}</div>
          </div>
          <StatusBadge status={status} />
        </div>
        <div className="flex gap-2">
          {status !== "terminated" && (
            <>
              <button className="btn-ghost">restart</button>
              <button className="btn-danger" onClick={() => setShowFire(true)}>
                fire
              </button>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Error banner */}
        {status === "error" && error && (
          <div className="bg-accent-red/5 border border-accent-red/30 rounded-sm p-3 text-[12px] text-accent-red">
            <span className="font-semibold mr-2">error:</span>
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Config */}
          <div className="card p-4">
            <div className="label mb-3">configuration</div>
            <InfoRow label="type" value={AGENT_TYPE_LABELS[config.type]} />
            <InfoRow label="platform" value={PLATFORM_LABELS[config.platform.type]} />
            <InfoRow label="role" value={config.role} />
            <InfoRow
              label="resources"
              value={`${config.resources.cpus} CPU · ${config.resources.memoryMb}MB RAM`}
            />
            <InfoRow label="persistent" value={config.persistent ? "yes" : "no"} />
            <InfoRow label="platform ref" value={agent.platformRef || "—"} />
            <InfoRow
              label="created"
              value={new Date(config.createdAt).toLocaleString()}
            />
            <InfoRow
              label="last active"
              value={new Date(config.lastActiveAt).toLocaleString()}
            />
          </div>

          {/* Mission */}
          <div className="card p-4">
            <div className="label mb-3">mission</div>
            <div className="text-[12px] text-gray-300 mb-3 leading-relaxed">
              {config.mission.description}
            </div>
            <div className="label mb-2">steps</div>
            <MissionSteps agent={agent} />
            <div className="mt-3 pt-3 border-t border-surface-border flex items-center justify-between text-[11px]">
              <span className="label">on complete</span>
              <span className="text-gray-400">{config.mission.onComplete}</span>
            </div>
            {missionProgress.startedAt && (
              <div className="flex items-center justify-between text-[11px] mt-1">
                <span className="label">started</span>
                <span className="text-gray-500">
                  {new Date(missionProgress.startedAt).toLocaleString()}
                </span>
              </div>
            )}
            {missionProgress.completedAt && (
              <div className="flex items-center justify-between text-[11px] mt-1">
                <span className="label">completed</span>
                <span className="text-gray-500">
                  {new Date(missionProgress.completedAt).toLocaleString()}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Logs */}
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="label">logs</div>
            <span className="text-[10px] text-gray-600">{logs.length} lines</span>
          </div>
          <LogViewer logs={logs} className="h-48" />
        </div>

        {/* Env vars */}
        {Object.keys(config.env).length > 0 && (
          <div className="card p-4">
            <div className="label mb-3">environment</div>
            <div className="space-y-1">
              {Object.entries(config.env).map(([k, v]) => (
                <div key={k} className="flex items-center gap-2 text-[11px] font-mono">
                  <span className="text-accent-cyan">{k}</span>
                  <span className="text-gray-600">=</span>
                  <span className="text-gray-400">{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Fire modal */}
      {showFire && (
        <ConfirmModal
          title="Fire agent?"
          message={`"${config.name}" will be terminated and its container destroyed. Mission state will be preserved in ~/.devlet/agents/.`}
          confirmLabel="fire"
          danger
          onConfirm={() => {
            // TODO: trpc.agents.fire
            navigate("/");
          }}
          onCancel={() => setShowFire(false)}
        />
      )}
    </div>
  );
}
