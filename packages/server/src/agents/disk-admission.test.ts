import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentState } from "@devlet/shared";
import { admitAgent } from "./disk-admission.js";
test("concurrent hires validate after earlier reservation is persisted; failed admission does not jam queue", async () => {
  const state = { config: { platform: { type: "proxmox", node: "n", vmType: "lxc" }, resources: { cpus: 1, memoryMb: 1024, storageMb: 20480 } } } as AgentState;
  let reserved = 0;
  const deps = {
    validate: async () => { if (reserved >= 20) throw new Error("out of space"); return 20480; },
    save: async () => { await new Promise(r => setTimeout(r, 10)); reserved += 20; },
  };
  const result = await Promise.allSettled([admitAgent(structuredClone(state), deps), admitAgent(structuredClone(state), deps)]);
  assert.equal(result[0]?.status, "fulfilled"); assert.equal(result[1]?.status, "rejected");
  reserved = 0;
  await admitAgent(structuredClone(state), deps);
  assert.equal(reserved, 20);
});
