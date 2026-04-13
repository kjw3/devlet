import type { DockerStatus, PortainerStatus, ProxmoxStatus } from "@devlet/shared";
import { trpc } from "../trpc.js";

function ConnIcon({ ok, loading }: { ok: boolean; loading?: boolean }) {
  if (loading) return <span className="status-dot bg-gray-700 animate-pulse" />;
  return (
    <span className={`status-dot ${ok ? "bg-status-running" : "bg-status-error animate-pulse"}`} />
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-surface-border last:border-0 pb-4 mb-4 last:mb-0 last:pb-0">
      <div className="label mb-3">{title}</div>
      {children}
    </div>
  );
}

function DockerPanel({ status, loading }: { status?: DockerStatus; loading: boolean }) {
  return (
    <Section title="Docker">
      <div className="flex items-center justify-between text-[11px] py-0.5">
        <div className="flex items-center gap-2">
          <ConnIcon ok={status?.connected ?? false} loading={loading} />
          <span className="text-gray-300">
            {loading ? "..." : "local"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {status?.gpuAvailable && (
            <span className="text-[9px] text-accent-purple">GPU</span>
          )}
          {!loading && (
            <span className={`label ${status?.connected ? "text-status-running" : "text-status-error"}`}>
              {status?.connected
                ? `${status.containers.running}↑ ${status.containers.stopped}↓`
                : "offline"}
            </span>
          )}
        </div>
      </div>
      {status?.connected && (
        <div className="text-[10px] text-gray-600 pl-5 mt-0.5">v{status.version}</div>
      )}
      {status?.error && (
        <div className="text-[11px] text-gray-600 italic mt-1">{status.error}</div>
      )}
    </Section>
  );
}

function PortainerPanel({ status, loading }: { status?: PortainerStatus; loading: boolean }) {
  return (
    <Section title="Portainer">
      <div className="flex items-center gap-2 mb-2">
        <ConnIcon ok={status?.connected ?? false} loading={loading} />
        <span className="text-[12px] text-gray-300">
          {loading ? "..." : status?.connected ? `v${status.version}` : "disconnected"}
        </span>
      </div>
      {status?.connected && (
        <div className="space-y-1">
          {[...status.endpoints].sort((a, b) => a.name.localeCompare(b.name)).map((ep) => (
            <div key={ep.id} className="flex items-center justify-between text-[11px] py-0.5">
              <span className="text-gray-300 truncate">{ep.name}</span>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {ep.gpuAvailable && (
                  <span className="text-[9px] text-accent-purple">GPU</span>
                )}
                <span className={`label ${ep.status === 1 ? "text-status-running" : "text-status-error"}`}>
                  {ep.status === 1 ? "online" : "offline"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      {status?.error && (
        <div className="text-[11px] text-gray-600 italic mt-1">{status.error}</div>
      )}
    </Section>
  );
}

function ProxmoxPanel({ status, loading }: { status?: ProxmoxStatus; loading: boolean }) {
  return (
    <Section title="Proxmox">
      <div className="flex items-center gap-2 mb-2">
        <ConnIcon ok={status?.connected ?? false} loading={loading} />
        <span className="text-[12px] text-gray-300">
          {loading ? "..." : status?.connected ? `v${status.version}` : "disconnected"}
        </span>
      </div>
      {!status?.connected && status?.error && (
        <div className="text-[11px] text-gray-600 italic">{status.error}</div>
      )}
      {status?.connected && [...status.nodes].sort((a, b) => a.name.localeCompare(b.name)).map((node) => (
        <div key={node.name} className="text-[11px] py-0.5 flex justify-between">
          <span className="text-gray-300">{node.name}</span>
          <div className="flex items-center gap-2">
            {(node.gpuCount ?? 0) > 0 && (
              <span className="text-[9px] text-accent-purple">{node.gpuCount} GPU</span>
            )}
            <span className={node.status === "online" ? "text-status-running" : "text-status-error"}>
              {node.status}
            </span>
          </div>
        </div>
      ))}
    </Section>
  );
}

export function PlatformSidebar() {
  const { data: docker, isLoading: dockerLoading } = trpc.platforms.docker.status.useQuery(
    undefined,
    { refetchInterval: 10_000 }
  );
  const { data: portainer, isLoading: portainerLoading } = trpc.platforms.portainer.status.useQuery(
    undefined,
    { refetchInterval: 10_000 }
  );
  const { data: proxmox, isLoading: proxmoxLoading } = trpc.platforms.proxmox.status.useQuery(
    undefined,
    { refetchInterval: 10_000 }
  );

  return (
    <aside className="w-52 flex-shrink-0 border-l border-surface-border bg-surface p-4 overflow-y-auto">
      <div className="label mb-4 text-gray-600">platforms</div>
      <DockerPanel loading={dockerLoading} {...(docker ? { status: docker } : {})} />
      <PortainerPanel loading={portainerLoading} {...(portainer ? { status: portainer } : {})} />
      <ProxmoxPanel loading={proxmoxLoading} {...(proxmox ? { status: proxmox } : {})} />
    </aside>
  );
}
