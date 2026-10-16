import type { PlatformArchitecture } from "@devlet/shared";
export function normalizeArchitecture(value?: string): PlatformArchitecture {
  if (["amd64", "x86_64"].includes((value ?? "").toLowerCase())) return "amd64";
  if (["arm64", "aarch64"].includes((value ?? "").toLowerCase())) return "arm64";
  return "unknown";
}
/** Only count explicitly advertised devices; a runtime alone is not a GPU. */
export function dockerGpuCount(info: { GenericResources?: Array<{ NamedResourceSpec?: { Kind?: string; Value?: string } }> }): number | undefined {
  const ids = info.GenericResources?.filter(r => r.NamedResourceSpec?.Kind === "NVIDIA-GPU")
    .map(r => r.NamedResourceSpec?.Value).filter((id): id is string => Boolean(id));
  return ids?.length ? new Set(ids).size : undefined;
}
export function parseNvidiaInventory(output: string) {
  const devices = [...output.matchAll(/GPU (\d+):\s*([^\r\n]+?)\s*\(UUID:/g)];
  return { gpuCount: new Set(devices.map(d => d[1])).size, gpuModel: devices[0]?.[2] };
}
