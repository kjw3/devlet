export const BYTES_PER_GB = 1024 ** 3;
export const DEFAULT_AGENT_DISK_MAX_GB = 100;
/** Admin policy, independent of whether backing storage is shared or local. */
export function agentDiskMaximumGb(value?: string): number {
  const maximum = value ? Number(value) : DEFAULT_AGENT_DISK_MAX_GB;
  if (!Number.isSafeInteger(maximum) || maximum < 10) throw new Error("DEVLET_AGENT_DISK_MAX_GB must be a whole number of at least 10 GB");
  return maximum;
}
export interface DiskCapacity {
  supported: boolean;
  minimumGb: number;
  maximumGb?: number;
  availableGb?: number;
  reserveGb?: number;
  policyMaximumGb?: number;
  storage?: string;
  poolKey?: string;
  reason?: string;
}
export function diskMaximumGb(availableBytes: number, reserveGb: number, pendingGb = 0, policyMaximumGb = DEFAULT_AGENT_DISK_MAX_GB): number {
  return Math.min(policyMaximumGb, Math.max(0, Math.floor(availableBytes / BYTES_PER_GB - reserveGb - pendingGb)));
}
export function diskSizeError(gb: number, capacity: DiskCapacity): string | undefined {
  if (!capacity.supported) return capacity.reason ?? "Disk quotas are unavailable on this platform";
  if (capacity.policyMaximumGb !== undefined && gb > capacity.policyMaximumGb) return `Per-agent disk limit is ${capacity.policyMaximumGb} GB`;
  if (!Number.isSafeInteger(gb) || gb < capacity.minimumGb) return `Choose a whole disk size of at least ${capacity.minimumGb} GB`;
  if (capacity.maximumGb === undefined) return capacity.reason ?? "Free disk space is unknown; retry before hiring";
  if (gb > capacity.maximumGb) return `Only ${capacity.maximumGb} GB is available after storage reserves`;
  return undefined;
}
export function templateDiskGb(config: Record<string, unknown>): number {
  const key = ["scsi0", "virtio0", "sata0", "ide0"].find(k => typeof config[k] === "string");
  const match = key ? String(config[key]).match(/(?:^|,)size=(\d+(?:\.\d+)?)([KMGT])(?:,|$)/i) : null;
  if (!match) throw new Error("Cannot determine template root disk size");
  const factors: Record<string, number> = { K: 1 / 1024 ** 2, M: 1 / 1024, G: 1, T: 1024 };
  return Math.ceil(Number(match[1]) * factors[match[2]!.toUpperCase()]!);
}
