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
