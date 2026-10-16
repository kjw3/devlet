import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleAgent, type PlacementRequirements, type SchedulerContext } from "@devlet/shared";
import { listPlatformGroups, sameTarget } from "../src/components/PlacementPreview.js";

const requirements: PlacementRequirements = {
  type: "pi", resources: { cpus: 1, memoryMb: 1024 }, persistent: false, onComplete: "terminate",
};
const context: SchedulerContext = {
  docker: null, portainer: null, komodo: null,
  proxmox: { connected: true, nodes: [
    { name: "included", status: "online", cpuUsage: 0, memoryUsed: 0, memoryTotal: 65536 },
    { name: "excluded", status: "online", cpuUsage: 0, memoryUsed: 0, memoryTotal: 65536, excluded: true },
    { name: "offline", status: "offline", cpuUsage: 0, memoryUsed: 0, memoryTotal: 65536 },
  ] },
};
test("excluded nodes are absent; offline nodes remain disabled", () => {
  const candidates = listPlatformGroups(context, requirements)[0]!.candidates;
  assert.deepEqual(candidates.map(c => c.name), ["included", "offline"]);
  assert.equal(candidates[1]!.available, false);
});
test("single task is always LXC even with a stale VM override", () => {
  const p = listPlatformGroups(context, requirements, "qemu")[0]!.candidates[0]!.platform;
  assert.deepEqual(p, { type: "proxmox", node: "included", vmType: "lxc" });
});
test("long running defaults to LXC independently of persistence; VM override survives", () => {
  const req = { ...requirements, onComplete: "idle" as const };
  assert.deepEqual(listPlatformGroups(context, req)[0]!.candidates[0]!.platform,
    { type: "proxmox", node: "included", vmType: "lxc" });
  assert.deepEqual(listPlatformGroups(context, req, "qemu")[0]!.candidates[0]!.platform,
    { type: "proxmox", node: "included", vmType: "qemu" });
  assert.equal(sameTarget({ type: "proxmox", node: "included", vmType: "lxc" },
    { type: "proxmox", node: "included", vmType: "qemu" }), false);
});
test("scheduler uses LXC for single tasks and CPU long running agents", () => {
  for (const onComplete of ["terminate", "idle"] as const) {
    assert.deepEqual(scheduleAgent({ ...requirements, onComplete }, context).placement,
      { type: "proxmox", node: "included", vmType: "lxc" });
  }
});
