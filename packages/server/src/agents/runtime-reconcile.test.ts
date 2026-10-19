import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentState } from "@devlet/shared";
import { reconcilePersistentAgent } from "./runtime-reconcile.js";

function fixture(overrides: { status?: AgentState["status"]; error?: string } = {}): AgentState {
  return {
    config: {
      id: "agent-test",
      name: "test",
      type: "pi",
      role: "test",
      platform: { type: "komodo", serverId: "srv1" },
      resources: { cpus: 1, memoryMb: 1024 },
      mission: { description: "test", steps: [], onComplete: "report" },
      persistent: true,
      env: {},
      createdAt: "",
      lastActiveAt: "",
    },
    status: overrides.status ?? "error",
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    platformRef: "komodo:srv1:devlet-agent-test",
    missionProgress: { currentStep: 0, completed: [], startedAt: "" },
    logs: [],
  };
}

test("runtime running + agent in error → error cleared, back to running", async () => {
  const state = fixture({ status: "error", error: "Komodo server srv1 is offline or unreachable" });
  let saved: AgentState | null = null;
  await reconcilePersistentAgent(state, true, {
    provision: async () => assert.fail("should not reprovision"),
    save: async (s) => { saved = s; },
  });
  assert.equal(state.status, "running");
  assert.equal(state.error, undefined);
  assert.equal(saved, state);
  assert.ok(state.logs.some((l) => l.includes("error state cleared")));
});

test("runtime running + agent already running → no-op, no save", async () => {
  const state = fixture({ status: "running" });
  let saves = 0;
  await reconcilePersistentAgent(state, true, {
    provision: async () => "komodo:srv1:devlet-agent-test",
    save: async () => { saves++; },
  });
  assert.equal(saves, 0);
  assert.equal(state.status, "running");
});

test("runtime missing + persistent → reprovisioned in place", async () => {
  const state = fixture({ status: "error", error: "old" });
  await reconcilePersistentAgent(state, false, {
    provision: async () => "komodo:srv1:devlet-agent-test",
    save: async () => {},
  });
  assert.equal(state.status, "running");
  assert.equal(state.error, undefined);
  assert.ok(state.logs.some((l) => l.includes("reprovisioned")));
});

test("reprovision failure → generic safe error persisted, not leaked", async () => {
  const state = fixture({ status: "error", error: "old" });
  await reconcilePersistentAgent(state, false, {
    provision: async () => { throw new Error("bootstrap-secret TOKEN=abc command failed"); },
    save: async () => {},
  });
  assert.equal(state.status, "error");
  assert.ok(state.error);
  assert.ok(!state.error.includes("bootstrap-secret"));
  assert.ok(state.logs.at(-1) === `[devlet] ${state.error}`);
});

test("unknown runtime (null) → no-op, no save", async () => {
  const state = fixture({ status: "error", error: "old" });
  let saves = 0;
  await reconcilePersistentAgent(state, null, {
    provision: async () => "komodo:srv1:devlet-agent-test",
    save: async () => { saves++; },
  });
  assert.equal(saves, 0);
  assert.equal(state.status, "error");
  assert.equal(state.error, "old");
});
