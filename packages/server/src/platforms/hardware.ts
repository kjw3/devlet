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
  const devices = [...output.matchAll(/GPU (\d+):\s*([^\r\n]+?)\s*\(UUID:\s*([^)]+)\)/g)];
  return {
    gpuCount: new Set(devices.map(d => d[1])).size,
    gpuModel: devices[0]?.[2],
    // One entry per physical GPU, keyed by UUID — what the hire-time GPU
    // selector offers on container platforms.
    gpuDevices: devices.map(d => ({ id: d[3]!.trim(), model: d[2]!.trim() })),
  };
}

/** `--gpus` value for a `docker run`: specific UUIDs when selected, else all. */
export function gpuRunArg(devices?: string[]): string {
  return devices?.length ? `device=${devices.join(",")}` : "all";
}

/**
 * HostConfig.DeviceRequests for a GPU-required agent — the Engine-API
 * equivalent of `docker run --gpus`. With device ids, exactly those GPUs are
 * exposed (`--gpus device=UUID-a,UUID-b`); without, all of them.
 */
export function gpuDeviceRequests(devices?: string[]): Array<{
  Driver: string;
  Count?: number;
  DeviceIDs?: string[];
  Capabilities: string[][];
  Options: Record<string, string>;
}> {
  if (devices?.length) {
    return [{
      Driver: "nvidia",
      DeviceIDs: devices,
      Capabilities: [["gpu", "compute", "utility"]],
      Options: {},
    }];
  }
  return [{
    Driver: "nvidia",
    Count: -1,
    Capabilities: [["gpu", "compute", "utility"]],
    Options: {},
  }];
}
