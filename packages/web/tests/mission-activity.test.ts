import assert from "node:assert/strict";
import { test } from "node:test";
import { missionActivityView } from "../src/lib/lifecycle.js";
import type { AgentState } from "@devlet/shared";

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    config: {
      id: "a1",
      name: "agent",
      type: "codex",
      role: "worker",
      mission: { description: "do a thing", steps: [], onComplete: "terminate" },
      platform: { type: "docker" },
      resources: { cpus: 1, memoryMb: 512 },
      env: {},
      persistent: false,
      createdAt: "2026-01-01T00:00:00Z",
      lastActiveAt: "2026-01-01T00:00:00Z",
    },
    status: "running",
    platformRef: "container:x",
    missionProgress: { currentStep: 0, completed: [], startedAt: "2026-01-01T00:00:00Z" },
    logs: [],
    ...overrides,
  } as AgentState;
}

test("running agent with an open mission process reports waiting-for-a-response", () => {
  const view = missionActivityView(agent({
    missionProgress: { currentStep: 0, completed: [], startedAt: "2026-01-01T00:00:00Z", activity: { state: "started", since: "2026-01-01T00:01:00Z" } },
  }));
  assert.equal(view?.label, "Task in progress — waiting for a response.");
  assert.equal(view?.tone, "active");
});

test("completed mission process reports completion, not a percentage", () => {
  const view = missionActivityView(agent({
    missionProgress: { currentStep: 0, completed: [], startedAt: "2026-01-01T00:00:00Z", activity: { state: "completed", since: "2026-01-01T00:05:00Z" } },
  }));
  assert.equal(view?.label, "Mission complete");
  assert.equal(view?.tone, "done");
});

test("failed mission process reports failure", () => {
  const view = missionActivityView(agent({
    missionProgress: { currentStep: 0, completed: [], startedAt: "2026-01-01T00:00:00Z", activity: { state: "failed", since: "2026-01-01T00:05:00Z" } },
  }));
  assert.equal(view?.label, "Mission failed — check logs");
  assert.equal(view?.tone, "failed");
});

test("running agent without a process signal falls back to 'Mission dispatched'", () => {
  const view = missionActivityView(agent());
  assert.equal(view?.label, "Mission dispatched");
  assert.equal(view?.tone, "active");
});

test("no mission means no activity claim at all", () => {
  const view = missionActivityView(agent({
    config: { id: "a1", name: "agent", type: "codex", role: "r", mission: { description: "", steps: [], onComplete: "idle" }, platform: { type: "docker" }, resources: { cpus: 1, memoryMb: 512 }, env: {}, persistent: true, createdAt: "x", lastActiveAt: "x" },
  }));
  assert.equal(view, null);
});

test("error and terminated states report runtime truth, never task progress", () => {
  assert.equal(missionActivityView(agent({ status: "error" }))?.label, "Mission interrupted");
  assert.equal(missionActivityView(agent({ status: "terminated" }))?.label, "Mission ended");
});
