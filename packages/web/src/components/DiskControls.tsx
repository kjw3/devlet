import type { DiskCapacity } from "@devlet/shared";
export function DiskControls({ gb, capacity, loading, error, onChange }: {
  gb: number; capacity: DiskCapacity | undefined; loading: boolean; error: string | undefined; onChange: (gb: number) => void;
}) {
  return <div className="mb-4">
    <label className="label block mb-2">Disk (GB)</label>
    {capacity?.supported ? <>
      <input aria-label="Disk (GB)" type="number" step={1} min={capacity.minimumGb} max={capacity.maximumGb}
        value={gb} onChange={e => onChange(Number(e.target.value))}
        className="bg-surface border border-surface-border rounded-sm px-3 py-2 text-[13px] text-gray-100" />
      <p className="text-[11px] text-gray-500 mt-1">Minimum {capacity.minimumGb} GB · Maximum {capacity.maximumGb ?? "unknown"} GB</p>
      <p className="text-[11px] text-gray-500">Storage: {capacity.storage ?? "unknown"} · Free: {capacity.availableGb ?? "unknown"} GB · Reserve: {capacity.reserveGb ?? "unknown"} GB</p>
      <p className="text-[10px] text-gray-600">Includes OS, Docker, images, and workspace. 1 GB = 1,024 MB. Maximum excludes safety reserves and pending hires; shared storage usage can change.</p>
    </> : <p className="text-[11px] text-gray-500">{loading ? "Checking disk capacity…" : capacity?.reason ?? "Select a host to check disk capacity."}</p>}
    {error && <p role="alert" className="text-[11px] text-red-400 mt-1">{error}</p>}
  </div>;
}
