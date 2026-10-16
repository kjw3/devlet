import assert from "node:assert/strict";
import { test } from "node:test";
import type { DockerStatus, KomodoStatus, PortainerStatus, ProxmoxStatus } from "@devlet/shared";
import { countGpuClaims, pickDefaultGpuDevices, resolveHostGpuDevices, validateGpuDeviceIds } from "./gpu-selection.js";
import { gpuRunArg } from "./hardware.js";
import { buildHostpciEntries, MAX_HOSTPCI_DEVICES } from "./proxmox-deploy.js";

const GPU_A = { id: "GPU-aaa", model: "NVIDIA GeForce GT 1030" };
const GPU_B = { id: "GPU-bbb", model: "NVIDIA A100" };

test("gpuRunArg: selected UUIDs become device=, no selection means all", () => {
  assert.equal(gpuRunArg(["GPU-aaa", "GPU-bbb"]), "device=GPU-aaa,GPU-bbb");
  assert.equal(gpuRunArg(undefined), "all");
  assert.equal(gpuRunArg([]), "all");
});

test("buildHostpciEntries maps selected PCI ids onto hostpci0..N in wizard order", () => {
  assert.deepEqual(buildHostpciEntries(["0000:01:00.0", "0000:02:00.0"]), [
    ["hostpci0", "0000:01:00.0"],
    ["hostpci1", "0000:02:00.0"],
  ]);
  assert.equal(buildHostpciEntries([]).length, 0);
  // PVE exposes hostpci0–3 only — overflow is truncated here and rejected by the caller.
  assert.equal(MAX_HOSTPCI_DEVICES, 4);
  assert.equal(
    buildHostpciEntries(["0", "1", "2", "3", "4"]).length,
    4
  );
});

test("validateGpuDeviceIds rejects unknown GPUs with the available inventory", () => {
  const result = validateGpuDeviceIds({ type: "komodo", serverId: "srv-02" }, ["GPU-zzz"], [GPU_A, GPU_B]);
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /not available on Komodo server srv-02/);
  assert.match(result.message ?? "", /aaa/);
});

test("validateGpuDeviceIds rejects busy Proxmox GPUs (exclusive passthrough)", () => {
  const devices = [
    { id: "0000:01:00.0", model: "NVIDIA A100", busy: true },
    { id: "0000:02:00.0", model: "NVIDIA A100" },
  ];
  const busy = validateGpuDeviceIds({ type: "proxmox", node: "pve-01", vmType: "qemu" }, ["0000:01:00.0"], devices);
  assert.equal(busy.ok, false);
  assert.match(busy.message ?? "", /already passed through/);
  const free = validateGpuDeviceIds({ type: "proxmox", node: "pve-01", vmType: "qemu" }, ["0000:02:00.0"], devices);
  assert.equal(free.ok, true);
});

test("validateGpuDeviceIds accepts a full-subset selection and ignores empties", () => {
  assert.deepEqual(validateGpuDeviceIds({ type: "docker" }, [GPU_A.id, GPU_B.id], [GPU_A, GPU_B]), { ok: true });
  assert.deepEqual(validateGpuDeviceIds({ type: "docker" }, [], []), { ok: true });
});

test("resolveHostGpuDevices reads the pinned host's inventory from probe data", () => {
  const statuses = {
    docker: null,
    portainer: null,
    proxmox: {
      connected: true,
      observedAt: "",
      nodes: [
        { name: "pve-01", status: "online", gpuDevices: [{ id: "0000:01:00.0", model: "NVIDIA A100" }] },
      ],
    } as unknown as ProxmoxStatus,
    komodo: {
      connected: true,
      observedAt: "",
      servers: [{ id: "srv-02", name: "gpu1", state: "ok", gpuDevices: [GPU_A] }],
    } as unknown as KomodoStatus,
  };
  assert.deepEqual(
    resolveHostGpuDevices({ type: "proxmox", node: "pve-01", vmType: "qemu" }, statuses).devices,
    [{ id: "0000:01:00.0", model: "NVIDIA A100" }]
  );
  assert.deepEqual(
    resolveHostGpuDevices({ type: "komodo", serverId: "srv-02" }, statuses).devices,
    [GPU_A]
  );
  // By-name lookup also works for Komodo (CLI accepts names).
  assert.deepEqual(
    resolveHostGpuDevices({ type: "komodo", serverId: "gpu1" }, statuses).devices,
    [GPU_A]
  );
});

test("resolveHostGpuDevices fails closed for offline or missing hosts", () => {
  const offline = resolveHostGpuDevices({ type: "komodo", serverId: "srv-x" }, {
    docker: null,
    portainer: null,
    proxmox: null,
    komodo: { connected: true, observedAt: "", servers: [{ id: "srv-x", name: "x", state: "not-ok" }] } as unknown as KomodoStatus,
  });
  assert.equal(offline.ok, false);
  assert.match(offline.message ?? "", /not online/);

  const missing = resolveHostGpuDevices({ type: "portainer", endpointId: 3, stackName: "s" }, {
    docker: null,
    portainer: { connected: true, observedAt: "", endpoints: [] } as unknown as PortainerStatus,
    proxmox: null,
    komodo: null,
  });
  assert.equal(missing.ok, false);
});

test("resolveHostGpuDevices tolerates Docker hosts without enumerable GPUs", () => {
  const devices = resolveHostGpuDevices({ type: "docker" }, {
    docker: { connected: true, observedAt: "", containers: { running: 0, stopped: 0, total: 0 }, gpuAvailable: true } as DockerStatus,
    portainer: null,
    proxmox: null,
    komodo: null,
  });
  assert.equal(devices.ok, true);
  assert.deepEqual(devices.devices, []);
});

test("countGpuClaims counts active agents per device, per host, skipping dead ones", () => {
  const agent = (id: string, platform: any, gpuDevices: string[] | undefined, status: any) => ({
    config: { id, platform, ...(gpuDevices ? { gpu: { required: true, devices: gpuDevices } } : {}) },
    status,
  });
  const states = [
    agent("a", { type: "komodo", serverId: "srv-02" }, ["GPU-aaa"], "running"),
    agent("b", { type: "komodo", serverId: "srv-02" }, ["GPU-aaa", "GPU-bbb"], "provisioning"),
    agent("c", { type: "komodo", serverId: "srv-02" }, ["GPU-ccc"], "terminated"),
    agent("d", { type: "komodo", serverId: "other" }, ["GPU-aaa"], "running"),
    agent("e", { type: "docker" }, ["GPU-aaa"], "running"),
  ];
  const claims = countGpuClaims(states, { type: "komodo", serverId: "srv-02" });
  assert.equal(claims.get("GPU-aaa"), 2);
  assert.equal(claims.get("GPU-bbb"), 1);
  assert.equal(claims.has("GPU-ccc"), false); // terminated agents release claims
  assert.equal(claims.size, 2);
});

test("pickDefaultGpuDevices: least-claimed GPU wins on container platforms", () => {
  const inventory = [{ id: "GPU-aaa" }, { id: "GPU-bbb" }];
  const claims = new Map([["GPU-aaa", 2]]);
  assert.deepEqual(pickDefaultGpuDevices({ type: "komodo", serverId: "s" }, inventory, claims), { devices: ["GPU-bbb"] });
  // No claims recorded — deterministic first pick (sharing is allowed).
  assert.deepEqual(pickDefaultGpuDevices({ type: "komodo", serverId: "s" }, inventory, new Map()), { devices: ["GPU-aaa"] });
});

test("pickDefaultGpuDevices: Proxmox requires a free GPU; unknown inventory falls back to all", () => {
  const busy = [{ id: "0000:01:00.0", busy: true }];
  assert.match((pickDefaultGpuDevices({ type: "proxmox", node: "pve-01", vmType: "qemu" }, busy, new Map()) as any).error, /already passed through/);
  const mixed = [{ id: "0000:01:00.0", busy: true }, { id: "0000:02:00.0" }];
  assert.deepEqual(pickDefaultGpuDevices({ type: "proxmox", node: "pve-01", vmType: "qemu" }, mixed, new Map()), { devices: ["0000:02:00.0"] });
  assert.deepEqual(pickDefaultGpuDevices({ type: "docker" }, [], new Map()), { devices: [] });
});
