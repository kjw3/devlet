import assert from "node:assert/strict";
import { test } from "node:test";
import { validateProxmoxPlacement } from "./proxmox.js";
import type { ProxmoxStatus } from "@devlet/shared";
const status: ProxmoxStatus = { connected: true, nodes: [
  { name: "node", status: "online", cpuUsage: 0, memoryUsed: 0, memoryTotal: 65536 },
] };
test("reject single-task VM override before provisioning", async () => {
  assert.deepEqual(await validateProxmoxPlacement({ type: "proxmox", node: "node", vmType: "qemu" }, status, { singleTask: true }),
    { ok: false, message: "Single-task Proxmox agents must use LXC" });
});
test("reject LXC GPU override", async () => {
  assert.deepEqual(await validateProxmoxPlacement({ type: "proxmox", node: "node", vmType: "lxc" }, status, { gpuRequired: true }),
    { ok: false, message: "Proxmox GPU passthrough requires a VM, not LXC" });
});
test("reject excluded node override", async () => {
  const result = await validateProxmoxPlacement({ type: "proxmox", node: "node", vmType: "lxc" },
    { ...status, nodes: status.nodes.map(n => ({ ...n, excluded: true })) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /excluded/);
});
