import type { PlatformTarget, SchedulerContext, ResourceLimits } from "./types/index.js";

/** Host capacity, not a reservation or instantaneous idle CPU measurement. */
export interface HostCapacity { cpus?: number; memoryMb?: number }
const positive = (n: number | undefined): number | undefined =>
  n !== undefined && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;

export function getHostCapacity(target: PlatformTarget | undefined, ctx: Partial<SchedulerContext>): HostCapacity {
  let cpus: number | undefined;
  let memoryMb: number | undefined;
  if (target?.type === "docker") {
    cpus = ctx.docker?.coreCount; memoryMb = ctx.docker?.totalMemoryMb;
  } else if (target?.type === "portainer") {
    const host = ctx.portainer?.endpoints.find(h => h.id === target.endpointId);
    cpus = host?.coreCount; memoryMb = host?.totalMemoryMb;
  } else if (target?.type === "proxmox") {
    const host = ctx.proxmox?.nodes.find(h => h.name === target.node);
    cpus = host?.coreCount; memoryMb = host?.memoryTotal;
  } else if (target?.type === "komodo") {
    const host = ctx.komodo?.servers.find(h => h.id === target.serverId);
    cpus = host?.coreCount;
    memoryMb = host?.totalMemoryGb === undefined ? undefined : host.totalMemoryGb * 1024;
  }
  return { ...(positive(cpus) ? { cpus: positive(cpus)! } : {}),
    ...(positive(memoryMb) ? { memoryMb: positive(memoryMb)! } : {}) };
}

export function isStandardMemory(memoryMb: number): boolean {
  return Number.isInteger(memoryMb) && memoryMb >= 128 && Number.isInteger(Math.log2(memoryMb));
}

export function memoryOptions(min: number, max: number): number[] {
  const options: number[] = [];
  for (let mb = 128; mb <= max && Number.isSafeInteger(mb); mb *= 2) {
    if (mb >= min) options.push(mb);
  }
  return options;
}

export function resourceCapacityError(resources: ResourceLimits, capacity: HostCapacity): string | undefined {
  if (capacity.cpus !== undefined && resources.cpus > capacity.cpus)
    return `Selected host has ${capacity.cpus} CPUs; requested ${resources.cpus}`;
  if (capacity.memoryMb !== undefined && resources.memoryMb > capacity.memoryMb)
    return `Selected host has ${capacity.memoryMb} MB RAM; requested ${resources.memoryMb} MB`;
  return undefined;
}
