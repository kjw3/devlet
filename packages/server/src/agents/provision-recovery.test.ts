import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentState } from "@devlet/shared";
import "../platforms/localstorage-shim.js";
const { recoverInterruptedProvisions } = await import("./provision-recovery.js");
function fixture(): AgentState {
  return { config: { id: "agent-test", name: "test", type: "pi", role: "test", platform: { type: "proxmox", node: "node", vmType: "lxc" }, resources: { cpus: 1, memoryMb: 1024 }, mission: { description: "test", steps: [], onComplete: "terminate" }, persistent: false, env: {}, createdAt: "", lastActiveAt: "" }, status: "provisioning", platformRef: "pending", missionProgress: { currentStep: 0, completed: [], startedAt: "" }, logs: [] };
}
test("startup resumes single-task provisions in recovery mode", async () => {
  const state = fixture(); let calls = 0;
  await recoverInterruptedProvisions([state], { load: async () => state, save: async () => {}, provision: async (_, recovery) => { assert.equal(recovery, true); calls++; return "proxmox:node:lxc:4100"; } });
  assert.equal(calls, 1); assert.equal(state.status, "running"); assert.equal(state.platformRef, "proxmox:node:lxc:4100");
});
test("recovery failure becomes visible error without leaking bootstrap credentials", async () => {
  const state = fixture();
  await recoverInterruptedProvisions([state], { load: async () => state, save: async () => {}, provision: async () => { throw new Error("secret bootstrap env"); } });
  assert.equal(state.status, "error"); assert.match(state.error!, /Guest retained/); assert.ok(!JSON.stringify(state).includes("secret bootstrap env"));
});
test("only interrupted Proxmox jobs are resumed, not running agents or changed state", async () => {
  const running = fixture(); running.status = "running";
  const docker = fixture(); docker.config.platform = { type: "docker" };
  const stale = fixture(); const current = fixture(); current.status = "terminated";
  await recoverInterruptedProvisions([running, docker, stale], { load: async () => current, save: async () => { assert.fail("must not save"); }, provision: async () => { assert.fail("must not provision"); } });
});
