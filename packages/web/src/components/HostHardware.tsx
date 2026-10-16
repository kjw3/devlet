import type { PlatformArchitecture } from "@devlet/shared";

export function HostHardware({ architecture, gpuCount, gpuAvailable }: {
  architecture?: PlatformArchitecture | undefined;
  gpuCount?: number | undefined;
  gpuAvailable?: boolean | undefined;
}) {
  return <>
    <span className="text-[9px] text-gray-500 uppercase" title="Host CPU architecture">{architecture && architecture !== "unknown" ? architecture : "arch unknown"}</span>
    <span className={`text-[9px] ${gpuCount || gpuAvailable ? "text-accent-purple" : "text-gray-600"}`}
      title="Detected graphics processing units; not necessarily free for allocation">
      {gpuCount !== undefined ? `${gpuCount} GPU${gpuCount === 1 ? "" : "s"}` : "GPUs: unknown"}
    </span>
  </>;
}
