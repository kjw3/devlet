import type { PlatformArchitecture } from "@devlet/shared";

export function HostHardware({ architecture, gpuCount, gpuAvailable, gpuBusyCount }: {
  architecture?: PlatformArchitecture | undefined;
  gpuCount?: number | undefined;
  gpuAvailable?: boolean | undefined;
  /** GPUs claimed by another VM's passthrough config (Proxmox only) */
  gpuBusyCount?: number | undefined;
}) {
  const allBusy = gpuCount !== undefined && (gpuBusyCount ?? 0) >= gpuCount && gpuCount > 0;
  return <>
    {((gpuCount ?? 0) > 0 || (gpuCount === undefined && gpuAvailable)) && (
      <span className={`text-[9px] ${allBusy ? "text-gray-500" : "text-accent-purple"}`}
        title="Detected graphics processing units; not necessarily free for allocation">
        {gpuCount !== undefined
          ? `${gpuCount} GPU${gpuCount === 1 ? "" : "s"}${allBusy ? " (in use)" : ""}`
          : "GPUs: unknown"}
      </span>
    )}
    <span className="text-[9px] text-gray-500 uppercase" title="Host CPU architecture">{architecture && architecture !== "unknown" ? architecture : "arch unknown"}</span>
  </>;
}
