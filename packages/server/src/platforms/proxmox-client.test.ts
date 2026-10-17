// Unit tests for the Proxmox API client. Run with:
//   node --import tsx --test packages/server/src/platforms/proxmox-client.test.ts
//
// The transport is stubbed, so no live Proxmox instance is needed. Env vars are
// set before config.ts is imported (it reads process.env at module load).
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

process.env["PROXMOX_URL"] = "https://pve.test:8006";
process.env["PROXMOX_USER"] = "devlet@pam";
process.env["PROXMOX_TOKEN_ID"] = "devlet";
process.env["PROXMOX_TOKEN_SECRET"] = "secret-uuid";

const { default: http } = await import("node:http");
const {
  pveGet,
  pvePost,
  ProxmoxApiError,
  ProxmoxTaskError,
  parseUpid,
  waitForTask,
  deriveVmidBase,
  devletGuestName,
  allocateVmid,
  firstGlobalIpv4,
  setProxmoxTransportForTests,
} = await import("./proxmox-client.js");

type Handler = (
  method: string,
  path: string,
  body?: string
) => { status?: number; body?: unknown };

function installHandler(handler: Handler) {
  return setProxmoxTransportForTests({
    async request(method, url, _headers, body) {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/^\/api2\/json/, "");
      const result = handler(method, path, body);
      return {
        status: result.status ?? 200,
        body: JSON.stringify(result.body ?? {}),
      };
    },
  });
}

beforeEach(() => {
  installHandler(() => ({ status: 500 }));
});

afterEach(() => {
  // Restore real transport; each test installs its own handler anyway.
  setProxmoxTransportForTests({
    request: () => {
      throw new Error("no transport installed");
    },
  } as never);
});

// ─── Auth / requests ───────────────────────────────────────────────────────────

test("pveGet unwraps the { data } envelope and hits the right path", async () => {
  const restore = installHandler((method, path) => {
    assert.equal(method, "GET");
    assert.equal(path, "/cluster/nextid");
    return { body: { data: 4123 } };
  });
  try {
    assert.equal(await pveGet<number>("/cluster/nextid"), 4123);
  } finally {
    setProxmoxTransportForTests(restore);
  }
});

test("pvePost sends form-encoded bodies", async () => {
  let seenBody: string | undefined;
  const restore = installHandler((method, path, body) => {
    assert.equal(method, "POST");
    seenBody = body;
    return { body: { data: "UPID:pve1:1:2:3:xyzstart:lxc:4100:devlet@pam:" } };
  });
  try {
    const upid = await pvePost<string>("/nodes/pve1/lxc", { vmid: 4100, start: 1 });
    assert.match(upid!, /^UPID:pve1:/);
    assert.ok(seenBody!.includes("vmid=4100"));
    assert.ok(seenBody!.includes("start=1"));
    assert.ok(seenBody!.startsWith("Content-Type") === false);
  } finally {
    setProxmoxTransportForTests(restore);
  }
});

test("pveGet raises ProxmoxApiError with PVE error details on 4xx", async () => {
  const restore = installHandler(() => ({
    status: 500,
    body: { errors: "storage 'local-lvm' does not exist" },
  }));
  try {
    await assert.rejects(
      pveGet("/nodes/pve1/storage/local-lvm/status"),
      (err: unknown) =>
        err instanceof ProxmoxApiError &&
        err.status === 500 &&
        err.message.includes("local-lvm")
    );
  } finally {
    setProxmoxTransportForTests(restore);
  }
});

// ─── UPID parsing / task polling ───────────────────────────────────────────────

test("parseUpid extracts node and task type", () => {
  const upid = "UPID:pve-01:00123456:00000001:67F00000:vzcreate:4100:devlet@pam:";
  const parsed = parseUpid(upid);
  assert.equal(parsed.node, "pve-01");
  assert.equal(parsed.taskType, "vzcreate");
});

test("parseUpid rejects malformed ids", () => {
  assert.throws(() => parseUpid("not-a-upid"));
});

test("waitForTask resolves on OK and throws with log tail on failure", async () => {
  const upid = "UPID:pve1:1:1:1:vzcreate:4100:devlet@pam:";

  const restore = installHandler((method, path) => {
    if (path.endsWith("/status")) {
      return { body: { data: { status: "stopped", exitstatus: "ERR: creation failed" } } };
    }
    if (path.endsWith("/log")) {
      return { body: { data: [{ n: 1, t: "Task ended with ExitCode 1" }] } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  try {
    await assert.rejects(
      waitForTask(upid, { pollMs: 1 }),
      (err: unknown) =>
        err instanceof ProxmoxTaskError &&
        err.message.includes("creation failed") &&
        err.taskLog.some((l) => l.includes("ExitCode"))
    );
  } finally {
    setProxmoxTransportForTests(restore);
  }
});

test("waitForTask polls until stopped then succeeds", async () => {
  const upid = "UPID:pve1:1:1:1:vzstart:4100:devlet@pam:";
  let polls = 0;
  const restore = installHandler((_method, path) => {
    if (path.endsWith("/status")) {
      polls += 1;
      return {
        body: { data: { status: polls < 3 ? "running" : "stopped", exitstatus: "OK" } },
      };
    }
    throw new Error(`unexpected ${path}`);
  });
  try {
    await waitForTask(upid, { pollMs: 1 });
    assert.ok(polls >= 3);
  } finally {
    setProxmoxTransportForTests(restore);
  }
});

// ─── VMID allocation (D3) ──────────────────────────────────────────────────────

test("deriveVmidBase is deterministic and stays in the Devlet pool", () => {
  for (const id of ["agent-abcd", "agent-xyz9", "agent-1"]) {
    const a = deriveVmidBase(id);
    const b = deriveVmidBase(id);
    assert.equal(a, b);
    assert.ok(a >= 4100 && a < 5000, `${a} in [4100, 5000)`);
  }
  assert.notEqual(deriveVmidBase("agent-abcd"), deriveVmidBase("agent-xyz9"));
});

test("devletGuestName prefixes agent ids", () => {
  assert.equal(devletGuestName("agent-abcd"), "devlet-agent-abcd");
});

test("allocateVmid reuses an existing devlet guest anywhere in the cluster", async () => {
  const restore = installHandler(() => ({
    body: {
      data: [
        { vmid: 4123, name: "devlet-agent-abcd", type: "lxc", node: "pve-2", status: "stopped" },
        { vmid: 100, name: "other-vm", type: "qemu", node: "pve-1", status: "running" },
      ],
    },
  }));
  try {
    const alloc = await allocateVmid("agent-abcd");
    assert.equal(alloc.vmid, 4123);
    assert.deepEqual(alloc.existingGuest, { node: "pve-2", vmType: "lxc", vmid: 4123 });
  } finally {
    setProxmoxTransportForTests(restore);
  }
});

test("allocateVmid skips taken VMIDs and never collides with foreign guests", async () => {
  const base = deriveVmidBase("agent-new");
  const restore = installHandler(() => ({
    body: {
      data: [
        { vmid: base, name: "someone-elses-vm", type: "qemu", node: "pve-1", status: "running" },
      ],
    },
  }));
  try {
    const alloc = await allocateVmid("agent-new");
    assert.equal(alloc.existingGuest, null);
    assert.notEqual(alloc.vmid, base);
    assert.ok(alloc.vmid >= 4100 && alloc.vmid < 5000);
  } finally {
    setProxmoxTransportForTests(restore);
  }
});

// ─── IP resolution (D5) ────────────────────────────────────────────────────────

test("firstGlobalIpv4 skips loopback and strips CIDR", () => {
  assert.equal(
    firstGlobalIpv4([
      { name: "lo", inet: "127.0.0.1/8" },
      { name: "eth0", inet: "192.168.1.42/24" },
    ]),
    "192.168.1.42"
  );
  assert.equal(firstGlobalIpv4([{ name: "eth0", inet: "fe80::1/64" }]), null);
  assert.equal(firstGlobalIpv4([]), null);
});

// ─── PCI resource mappings ────────────────────────────────────────────────────
const { listHostpciInUse, mappingCovers, pciSlotKey: slotKey } = await import("./proxmox-client.js");

test("mappingCovers matches node + slot, ignoring sub-device and case", () => {
  const mapping = {
    id: "devlet-gpu",
    map: ["pc2:0000:02:00.0", "pc2:0000:02:00.1", "pc1:0000:2b:00"],
  };
  assert.equal(mappingCovers(mapping, "pc2", "0000:02:00.0"), true);
  assert.equal(mappingCovers(mapping, "pc2", "0000:02:00"), true); // slot-only query
  assert.equal(mappingCovers(mapping, "pc1", "0000:2B:00.0"), true); // case-insensitive slot
  assert.equal(mappingCovers(mapping, "pc3", "0000:02:00.0"), false); // other node
  assert.equal(mappingCovers(mapping, "pc2", "0000:03:00.0"), false); // other device
});

test("listHostpciInUse expands mapping= entries to the pinned device on the node", async () => {
  installHandler((method, path) => {
    if (path === "/cluster/mapping/pci") {
      return { body: { data: [
        { id: "devlet-gpu", map: ["pc2:0000:02:00.0"] },
      ] } };
    }
    if (path === "/nodes/pc2/qemu") {
      return { body: { data: [{ vmid: 120, name: "gpu2" }] } };
    }
    if (path === "/nodes/pc2/qemu/120/config") {
      return { body: { data: { hostpci0: "mapping=devlet-gpu,pcie=1,rombar=0" } } };
    }
    return { body: { data: [] } };
  });
  const inUse = await listHostpciInUse("pc2");
  assert.equal(inUse.get(slotKey("0000:02:00.0")), "VM gpu2 (vmid 120)");
  // And the mapping is NOT counted as busy on an unrelated node's view.
  const otherNode = await listHostpciInUse("pc1");
  assert.equal(otherNode.size, 0);
});

test("mappingCovers parses PVE property-string map entries (node=...,path=...)", async () => {
  const { parsePciMapEntry } = await import("./proxmox-client.js");
  // Real PVE 8.1+ entry format (verbatim from a live /cluster/mapping/pci):
  const mapping = {
    id: "nvidia-rtx-3090",
    map: ["id=10de:2204,iommugroup=39,node=pc2,path=0000:02:00,subsystem-id=10de:147d"],
  };
  assert.equal(mappingCovers(mapping, "pc2", "0000:02:00.0"), true);
  assert.equal(mappingCovers(mapping, "pc2", "0000:02:00"), true);
  assert.equal(mappingCovers(mapping, "pc1", "0000:02:00.0"), false);
  const parsed = parsePciMapEntry(mapping.map[0]!);
  assert.deepEqual(parsed, { node: "pc2", path: "0000:02:00" });
});

test("gpuVramFloorMb sums VRAM from raw pciids with a conservative fallback", async () => {
  const { gpuVramFloorMb, GPU_VRAM_MIB_BY_PCIID } = await import("./proxmox-client.js");
  assert.equal(gpuVramFloorMb([]), 0);
  // RTX 3090 (the pc2 card) → 24 GiB
  assert.equal(gpuVramFloorMb([{ pciid: "10de:2204" }]), 24576);
  assert.equal(gpuVramFloorMb([{ pciid: "10DE:2204" }]), 24576); // case-insensitive
  // 3090 + 4080 → 24 + 16 GiB
  assert.equal(gpuVramFloorMb([{ pciid: "10de:2204" }, { pciid: "10de:2704" }]), 40960);
  // unknown / missing pciid → conservative fallback, never zero
  assert.equal(gpuVramFloorMb([{ pciid: "10de:ffff" }]), 8192);
  assert.equal(gpuVramFloorMb([{}]), 8192);
  // table sanity: fleet cards present
  assert.equal(GPU_VRAM_MIB_BY_PCIID["10de:1d01"], 2048); // GT 1030
});

test("normalizePciid derives vendor:device from PVE 9's 0x-prefixed fields", async () => {
  // PVE 9 hardware/pci returns separate vendor/device fields, no combined
  // pciid — this exact mismatch made the VRAM floor fall back to 8 GiB on a
  // live 3090 hire (VM 4105 got 8192 MB instead of 24576).
  const { normalizePciid } = await import("./proxmox-client.js");
  assert.equal(normalizePciid({ vendor: "0x10de", device: "0x2204" }), "10de:2204");
  assert.equal(normalizePciid({ vendor: "0x10DE", device: "0x2204" }), "10de:2204");
  // combined pciid wins when present (mapping API shape)
  assert.equal(normalizePciid({ pciid: "10DE:2204", vendor: "0x10de", device: "0x2204" }), "10de:2204");
  assert.equal(normalizePciid({}), undefined);
  assert.equal(normalizePciid({ vendor: "0x10de" }), undefined);
});

test("gpuVramFloorMb: the GPU's audio function must not shadow the GPU by slot key", async () => {
  // pc2's 3090 exposes 0000:02:00.0 (GPU, 10de:2204) and 0000:02:00.1
  // (audio, 10de:1a81). Slot-keyed maps let the audio device overwrite the
  // GPU entry → fallback 8192 instead of 24576 (live bug, VM 4716). The
  // deploy now keys by full device id — mirror that here.
  const devices = [
    { id: "0000:02:00.0", pciid: "10de:2204" },
    { id: "0000:02:00.1", pciid: "10de:1a81" }, // audio — not in the table
  ];
  const byId = new Map(devices.map((d) => [d.id.toLowerCase(), d]));
  const { gpuVramFloorMb } = await import("./proxmox-client.js");
  assert.equal(gpuVramFloorMb([byId.get("0000:02:00.0")!]), 24576);
});
