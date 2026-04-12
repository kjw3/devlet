import type { DockerStatus, PortainerStatus, ProxmoxStatus } from "@devlet/shared";
import { MOCK_DOCKER_STATUS, MOCK_PORTAINER_STATUS, MOCK_PROXMOX_STATUS } from "../mocks/platforms.js";

function ConnIcon({ ok }: { ok: boolean }) {
  return (
    <span
      className={`status-dot ${ok ? "bg-status-running" : "bg-status-error animate-pulse"}`}
    />
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

function DockerPanel({ status }: { status: DockerStatus }) {
  return (
    <Section title="Docker">
      <div className="flex items-center gap-2 mb-2">
        <ConnIcon ok={status.connected} />
        <span className="text-[12px] text-gray-300">
          {status.connected ? `v${status.version}` : "disconnected"}
        </span>
      </div>
      {status.connected && (
        <div className="grid grid-cols-3 gap-1 text-center">
          {[
            { label: "running", val: status.containers.running, color: "text-status-running" },
            { label: "stopped", val: status.containers.stopped, color: "text-gray-500" },
            { label: "total", val: status.containers.total, color: "text-gray-400" },
          ].map(({ label, val, color }) => (
            <div key={label} className="bg-surface-overlay rounded-sm py-1.5">
              <div className={`text-sm font-semibold ${color}`}>{val}</div>
              <div className="label">{label}</div>
            </div>
          ))}
        </div>
      )}
      {status.error && (
        <div className="text-[11px] text-accent-red mt-1">{status.error}</div>
      )}
    </Section>
  );
}

function PortainerPanel({ status }: { status: PortainerStatus }) {
  return (
    <Section title="Portainer">
      <div className="flex items-center gap-2 mb-2">
        <ConnIcon ok={status.connected} />
        <span className="text-[12px] text-gray-300">
          {status.connected ? `v${status.version}` : "disconnected"}
        </span>
      </div>
      {status.connected && (
        <div className="space-y-1">
          {status.endpoints.map((ep) => (
            <div
              key={ep.id}
              className="flex items-center justify-between text-[11px] py-0.5"
            >
              <span className="text-gray-300">{ep.name}</span>
              <span className={`label ${ep.status === 1 ? "text-status-running" : "text-status-error"}`}>
                {ep.status === 1 ? "online" : "offline"}
              </span>
            </div>
          ))}
        </div>
      )}
      {status.error && (
        <div className="text-[11px] text-accent-red mt-1">{status.error}</div>
      )}
    </Section>
  );
}

function ProxmoxPanel({ status }: { status: ProxmoxStatus }) {
  return (
    <Section title="Proxmox">
      <div className="flex items-center gap-2 mb-2">
        <ConnIcon ok={status.connected} />
        <span className="text-[12px] text-gray-300">
          {status.connected ? `v${status.version}` : "disconnected"}
        </span>
      </div>
      {!status.connected && status.error && (
        <div className="text-[11px] text-gray-500 italic">{status.error}</div>
      )}
      {status.connected && status.nodes.map((node) => (
        <div key={node.name} className="text-[11px] py-0.5 flex justify-between">
          <span className="text-gray-300">{node.name}</span>
          <span className={node.status === "online" ? "text-status-running" : "text-status-error"}>
            {node.status}
          </span>
        </div>
      ))}
    </Section>
  );
}

export function PlatformSidebar() {
  // TODO: replace with real tRPC queries
  const docker = MOCK_DOCKER_STATUS;
  const portainer = MOCK_PORTAINER_STATUS;
  const proxmox = MOCK_PROXMOX_STATUS;

  return (
    <aside className="w-52 flex-shrink-0 border-l border-surface-border bg-surface p-4 overflow-y-auto">
      <div className="label mb-4 text-gray-600">platforms</div>
      <DockerPanel status={docker} />
      <PortainerPanel status={portainer} />
      <ProxmoxPanel status={proxmox} />
    </aside>
  );
}
