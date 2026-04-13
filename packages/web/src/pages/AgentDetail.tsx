import { useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { AGENT_TYPE_LABELS } from "@devlet/shared";
import { trpc } from "../trpc.js";
import { StatusBadge } from "../components/StatusDot.js";
import { LogViewer } from "../components/LogViewer.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import type { AgentState } from "@devlet/shared";

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

// ─── Web Terminal panel ───────────────────────────────────────────────────────

function TerminalPanel({ env }: { env: Record<string, string> }) {
  const port  = env["DEVLET_TERMINAL_PORT"];
  const token = env["DEVLET_TERMINAL_TOKEN"];
  const url   = `http://localhost:${port}`;

  const [tokenVisible, setTokenVisible] = useState(false);
  const [copiedToken, setCopiedToken]   = useState(false);

  const copyToken = useCallback(() => {
    if (!token) return;
    void navigator.clipboard.writeText(token).then(() => {
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 1500);
    });
  }, [token]);

  return (
    <div className="card p-4">
      <div className="label mb-3">terminal</div>
      <div className="space-y-2.5">
        <div className="flex items-center gap-3">
          <span className="label w-16 flex-shrink-0">url</span>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] font-mono text-accent-cyan hover:underline"
          >
            {url}
          </a>
        </div>
        <div className="flex items-center gap-3">
          <span className="label w-16 flex-shrink-0">user</span>
          <span className="text-[12px] font-mono text-gray-400">devlet</span>
        </div>
        {token && (
          <div className="flex items-center gap-3">
            <span className="label w-16 flex-shrink-0">password</span>
            <span className="text-[12px] font-mono text-gray-400 flex-1 truncate">
              {tokenVisible ? token : "••••••••••••••••••••••••••••••••••••"}
            </span>
            <button
              onClick={() => setTokenVisible((v) => !v)}
              className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors px-1"
            >
              {tokenVisible ? "hide" : "show"}
            </button>
            <button
              onClick={copyToken}
              className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors px-1"
            >
              {copiedToken ? "copied ✓" : "copy"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── OpenClaw Control UI panel ────────────────────────────────────────────────

function OpenClawPanel({ agentId, env }: { agentId: string; env: Record<string, string> }) {
  const port  = env["OPENCLAW_HOST_PORT"];
  const token = env["OPENCLAW_GATEWAY_TOKEN"];
  const url     = `http://localhost:${port}`;
  const fullUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;

  const [copiedToken, setCopiedToken] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);

  const copyToken = useCallback(() => {
    if (!token) return;
    void navigator.clipboard.writeText(token).then(() => {
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 1500);
    });
  }, [token]);

  const { data: health } = trpc.agents.health.useQuery(agentId, {
    refetchInterval: 5_000,
  });

  const gwStatus = health === undefined
    ? "checking"
    : health?.ok
    ? "ready"
    : "unreachable";

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="label">control ui</div>
        {gwStatus === "ready" && (
          <span className="text-[10px] text-green-500 font-medium">ready</span>
        )}
        {gwStatus === "checking" && (
          <span className="text-[10px] text-gray-500 font-medium animate-pulse">checking…</span>
        )}
        {gwStatus === "unreachable" && (
          <span className="text-[10px] text-yellow-500 font-medium">unreachable</span>
        )}
      </div>

      <div className="space-y-2.5">
        {/* URL row */}
        <div className="flex items-center gap-3">
          <span className="label w-16 flex-shrink-0">url</span>
          <a
            href={fullUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] font-mono text-accent-cyan hover:underline"
          >
            {url}
          </a>
        </div>

        {/* Token row */}
        {token && (
          <div className="flex items-center gap-3">
            <span className="label w-16 flex-shrink-0">token</span>
            <span className="text-[12px] font-mono text-gray-400 flex-1 truncate">
              {tokenVisible ? token : "••••••••••••••••••••••••••••••••••••"}
            </span>
            <button
              onClick={() => setTokenVisible((v) => !v)}
              className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors px-1"
              title={tokenVisible ? "hide token" : "reveal token"}
            >
              {tokenVisible ? "hide" : "show"}
            </button>
            <button
              onClick={copyToken}
              className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors px-1"
              title="Copy token"
            >
              {copiedToken ? "copied ✓" : "copy"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Moltis gateway UI panel ─────────────────────────────────────────────────

function MoltisPanel({ agentId, env }: { agentId: string; env: Record<string, string> }) {
  const port = env["MOLTIS_HOST_PORT"];
  const url  = `http://localhost:${port}`;

  const { data: health } = trpc.agents.health.useQuery(agentId, {
    refetchInterval: 5_000,
  });

  const gwStatus = health === undefined
    ? "checking"
    : health?.ok
    ? "ready"
    : "unreachable";

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="label">moltis gateway</div>
        {gwStatus === "ready" && (
          <span className="text-[10px] text-green-500 font-medium">ready</span>
        )}
        {gwStatus === "checking" && (
          <span className="text-[10px] text-gray-500 font-medium animate-pulse">checking…</span>
        )}
        {gwStatus === "unreachable" && (
          <span className="text-[10px] text-yellow-500 font-medium">unreachable</span>
        )}
      </div>

      <div className="space-y-2.5">
        <div className="flex items-center gap-3">
          <span className="label w-20 flex-shrink-0">url</span>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] font-mono text-accent-cyan hover:underline"
          >
            {url}
          </a>
        </div>
        <div className="flex items-center gap-3">
          <span className="label w-20 flex-shrink-0">auth</span>
          <span className="text-[12px] text-gray-500">disabled (local gateway)</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [showFire, setShowFire] = useState(false);
  const [copied, setCopied] = useState(false);

  const utils = trpc.useUtils();

  const { data: agent, isLoading, error } = trpc.agents.get.useQuery(id!, {
    enabled: !!id,
    refetchInterval: 5_000,
  });

  const { data: liveLogs } = trpc.agents.logs.useQuery(id!, {
    enabled: !!id && !!agent,
    refetchInterval: agent?.status === "running" ? 3_000 : false,
  });

  const fireMutation = trpc.agents.fire.useMutation({
    onSuccess: () => navigate("/"),
  });
  const deleteMutation = trpc.agents.delete.useMutation({
    onSuccess: () => navigate("/"),
  });

  const restartMutation = trpc.agents.restart.useMutation({
    onSuccess: () => void utils.agents.get.invalidate(id),
  });

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 text-[12px] animate-pulse">
        loading agent...
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        <div className="text-center">
          <div className="text-sm mb-1">{error ? "error loading agent" : "agent not found"}</div>
          {error && <div className="text-[11px] text-accent-red mb-3">{error.message}</div>}
          <button className="btn-ghost" onClick={() => navigate("/")}>← back</button>
        </div>
      </div>
    );
  }

  const { config, status, missionProgress, error: agentError } = agent;
  const logs = liveLogs ?? agent.logs;

  function copyLogs() {
    void navigator.clipboard.writeText(logs.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

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
            <div className="mono-header text-base text-gray-100">{config.name}</div>
            <div className="text-[11px] text-gray-500">{config.id}</div>
          </div>
          <StatusBadge status={status} />
        </div>
        <div className="flex gap-2">
          {status !== "terminated" && (
            <>
              <button
                className="btn-ghost"
                disabled={restartMutation.isPending}
                onClick={() => restartMutation.mutate(config.id)}
              >
                {restartMutation.isPending ? "restarting..." : "restart"}
              </button>
              <button className="btn-danger" onClick={() => setShowFire(true)}>
                fire
              </button>
            </>
          )}
          {status === "terminated" && (
            <button
              className="btn-danger"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate(config.id)}
            >
              {deleteMutation.isPending ? "deleting..." : "delete"}
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {status === "error" && agentError && (
          <div className="bg-accent-red/5 border border-accent-red/30 rounded-sm p-3 text-[12px] text-accent-red">
            <span className="font-semibold mr-2">error:</span>
            {agentError}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card p-4">
            <div className="label mb-3">configuration</div>
            <InfoRow label="type" value={AGENT_TYPE_LABELS[config.type]} />
            <InfoRow label="platform" value={PLATFORM_LABELS[config.platform.type]} />
            <InfoRow label="role" value={config.role} />
            <InfoRow label="resources" value={`${config.resources.cpus} CPU · ${config.resources.memoryMb}MB RAM`} />
            <InfoRow label="persistent" value={config.persistent ? "yes" : "no"} />
            <InfoRow label="platform ref" value={agent.platformRef || "—"} />
            <InfoRow label="created" value={new Date(config.createdAt).toLocaleString()} />
            <InfoRow label="last active" value={new Date(config.lastActiveAt).toLocaleString()} />
          </div>

          <div className="card p-4">
            <div className="label mb-3">mission</div>
            <div className="text-[12px] text-gray-300 mb-3 leading-relaxed">
              {config.mission.description}
            </div>
            {config.mission.steps.length > 0 && (
              <>
                <div className="label mb-2">steps</div>
                <MissionSteps agent={agent} />
              </>
            )}
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

        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="label">logs</div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-600">{logs.length} lines</span>
              <button
                onClick={copyLogs}
                title="Copy logs"
                className="text-gray-600 hover:text-gray-300 transition-colors p-0.5"
              >
                {copied ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-cyan">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          <LogViewer logs={logs} className="h-48" />
        </div>

        {/* Web Terminal panel — all agent types */}
        {config.env["DEVLET_TERMINAL_PORT"] && (
          <TerminalPanel env={config.env} />
        )}

        {/* OpenClaw Control UI panel */}
        {config.type === "openclaw" && config.env["OPENCLAW_HOST_PORT"] && (
          <OpenClawPanel agentId={config.id} env={config.env} />
        )}

        {/* Moltis gateway UI panel */}
        {config.type === "moltis" && config.env["MOLTIS_HOST_PORT"] && (
          <MoltisPanel agentId={config.id} env={config.env} />
        )}

        {Object.keys(config.env).length > 0 && (
          <div className="card p-4">
            <div className="label mb-3">environment</div>
            <div className="space-y-1">
              {Object.entries(config.env)
                // Secrets shown in their respective panels; redact them here
                .filter(([k]) =>
                  k !== "OPENCLAW_GATEWAY_TOKEN" &&
                  k !== "DEVLET_TERMINAL_TOKEN"
                )
                .map(([k, v]) => (
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

      {showFire && (
        <ConfirmModal
          title="Fire agent?"
          message={`"${config.name}" will be terminated and its container destroyed. Mission state will be preserved in ~/.devlet/agents/.`}
          confirmLabel={fireMutation.isPending ? "firing..." : "fire"}
          danger
          onConfirm={() => fireMutation.mutate(config.id)}
          onCancel={() => setShowFire(false)}
        />
      )}
    </div>
  );
}
