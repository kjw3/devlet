import assert from "node:assert/strict";
import { test } from "node:test";
import { getHostCapacity, memoryOptions, resourceCapacityError, HireAgentInputSchema, scheduleAgent, AGENT_RESOURCE_MINS } from "@devlet/shared";
import type { SchedulerContext } from "@devlet/shared";
const ctx: SchedulerContext = { docker: null, portainer: null, komodo: null, proxmox: {
  connected: true, nodes: [
    { name: "small", status: "online", cpuUsage: 0, memoryUsed: 0, memoryTotal: 65536, coreCount: 2 },
    { name: "large", status: "online", cpuUsage: 0, memoryUsed: 0, memoryTotal: 32768, coreCount: 16 },
  ],
} };
test("RAM options start at the agent minimum and stop at host capacity", () => {
  assert.deepEqual(memoryOptions(AGENT_RESOURCE_MINS.pi.memoryMb, 3800), [512, 1024, 2048]);
  assert.deepEqual(memoryOptions(AGENT_RESOURCE_MINS.nemoclaw.memoryMb, 8192), [1024, 2048, 4096, 8192]);
  assert.deepEqual(memoryOptions(1024, 512), []);
});
test("capacity follows selected target", () => {
  assert.deepEqual(getHostCapacity({ type: "proxmox", node: "large", vmType: "lxc" }, ctx), { cpus: 16, memoryMb: 32768 });
  assert.deepEqual(getHostCapacity(undefined, ctx), {});
  assert.match(resourceCapacityError({ cpus: 17, memoryMb: 1024 }, { cpus: 16 })!, /16 CPUs/);
  assert.match(resourceCapacityError({ cpus: 1, memoryMb: 8192 }, { memoryMb: 4096 })!, /4096 MB/);
});
test("all platforms expose consistent capacity units", () => {
  assert.deepEqual(getHostCapacity({ type: "docker" }, { docker: { connected: true, containers: { running: 0, stopped: 0, total: 0 }, coreCount: 4, totalMemoryMb: 8000 } }), { cpus: 4, memoryMb: 8000 });
  assert.deepEqual(getHostCapacity({ type: "komodo", serverId: "s" }, { komodo: { connected: true, servers: [{ id: "s", name: "s", state: "ok", coreCount: 8, totalMemoryGb: 16 }] } }), { cpus: 8, memoryMb: 16384 });
  assert.deepEqual(getHostCapacity({ type: "portainer", endpointId: 1 }, { portainer: { connected: true, endpoints: [{ id: 1, name: "p", url: "", type: 1, status: 1, coreCount: 4, totalMemoryMb: 8192 }] } }), { cpus: 4, memoryMb: 8192 });
});
test("hire rejects fractional CPUs and nonstandard RAM without changing legacy state schemas", () => {
  const input = { name: "test", type: "pi", role: "test", mission: { description: "test", steps: [], onComplete: "terminate" }, env: {}, persistent: false };
  for (const resources of [{ cpus: 1.25, memoryMb: 1024 }, { cpus: 1, memoryMb: 1000 }, { cpus: 0, memoryMb: 1024 }]) {
    assert.equal(HireAgentInputSchema.safeParse({ ...input, resources }).success, false);
  }
  assert.equal(HireAgentInputSchema.safeParse({ ...input, resources: { cpus: 2, memoryMb: 2048 } }).success, true);
});
test("scheduler picks a host that fits instead of the best-scoring undersized host", () => {
  const decision = scheduleAgent({ type: "pi", persistent: false, resources: { cpus: 4, memoryMb: 1024 } }, ctx);
  assert.deepEqual(decision.placement, { type: "proxmox", node: "large", vmType: "lxc" });
});
