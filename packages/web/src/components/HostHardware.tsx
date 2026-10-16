import type { PlatformArchitecture } from "@devlet/shared";

export function HostHardware({ architecture, gpuCount, gpuAvailable }: {
  architecture?: PlatformArchitecture | undefined;
  gpuCount?: number | undefined;
  gpuAvailable?: boolean | undefined;
}) {
  return <>
    {((gpuCount ?? 0) > 0 || (gpuCount === undefined && gpuAvailable)) && (
      <span className="text-[9px] text-accent-purple"
        title="Detected graphics processing units; not necessarily free for allocation">
        {gpuCount !== undefined ? `${gpuCount} GPU${gpuCount === 1 ? "" : "s"}` : "GPUs: unknown"}
      </span>
    )}
    <span className="text-[9px] text-gray-500 uppercase" title="Host CPU architecture">{architecture && architecture !== "unknown" ? architecture : "arch unknown"}</span>
  </>;
}
