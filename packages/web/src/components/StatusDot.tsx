import type { AgentStatus } from "@devlet/shared";

const STATUS_STYLES: Record<AgentStatus, string> = {
  provisioning: "bg-status-provisioning animate-pulse",
  bootstrapping: "bg-status-bootstrapping animate-pulse",
  running: "bg-status-running",
  idle: "bg-status-idle",
  terminated: "bg-status-terminated",
  error: "bg-status-error animate-pulse",
};

interface StatusDotProps {
  status: AgentStatus;
  className?: string;
}

export function StatusDot({ status, className = "" }: StatusDotProps) {
  return (
    <span
      className={`status-dot ${STATUS_STYLES[status]} ${className}`}
      title={status}
    />
  );
}

export function StatusBadge({ status }: { status: AgentStatus }) {
  const dot = STATUS_STYLES[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider">
      <span className={`status-dot ${dot}`} />
      <span className="text-gray-400">{status}</span>
    </span>
  );
}
