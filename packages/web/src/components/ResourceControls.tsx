import { memoryOptions, type HostCapacity } from "@devlet/shared";

export function ResourceControls({ cpus, memoryMb, minimum, capacity, onCpu, onMemory, error }: {
  cpus: number; memoryMb: number; minimum: { cpus: number; memoryMb: number };
  capacity: HostCapacity; onCpu: (n: number) => void; onMemory: (n: number) => void;
  error?: string | undefined;
}) {
  // Unknown capacity is explicitly labelled, never treated as zero or a host limit.
  const ram = memoryOptions(minimum.memoryMb, capacity.memoryMb ?? 1048576);
  const cpuMin = Math.max(1, Math.ceil(minimum.cpus));
  return (
    <div className="mb-4">
      <div className="label mb-2">resource limits</div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-[11px] text-gray-500">CPUs
          <input aria-label="CPUs" type="number" min={cpuMin} max={capacity.cpus} step={1}
            value={cpus} onChange={e => onCpu(Number(e.target.value))}
            className="block w-full bg-surface border border-surface-border rounded-sm px-3 py-2 text-[13px] text-gray-100" />
          <span>Whole cores · min {cpuMin}{capacity.cpus ? ` · host max ${capacity.cpus}` : " · host capacity unknown"}</span>
        </label>
        <label className="text-[11px] text-gray-500">RAM
          <select aria-label="RAM" value={memoryMb} onChange={e => onMemory(Number(e.target.value))}
            className="block w-full bg-surface border border-surface-border rounded-sm px-3 py-2 text-[13px] text-gray-100">
            {!ram.includes(memoryMb) && <option value={memoryMb} disabled>{memoryMb} MB — not valid on this host</option>}
            {ram.map(mb => <option key={mb} value={mb}>{mb < 1024 ? `${mb} MB` : `${mb / 1024} GB (${mb} MB)`}</option>)}
          </select>
          <span>Min {minimum.memoryMb} MB{capacity.memoryMb ? ` · host total ${capacity.memoryMb} MB` : " · host capacity unknown"}</span>
        </label>
      </div>
      <p className="text-[10px] text-gray-600 mt-1">Limits use reported host capacity, not currently free resources. Shared hosts can still be under load.</p>
      {error && <p role="alert" className="text-[11px] text-red-400 mt-1">{error}</p>}
    </div>
  );
}
