import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@devlet/shared";
import "../platforms/localstorage-shim.js";
const { recordAgentEvent } = await import("./agent-events.js");
const { loadAgentState, saveAgentState, deleteAgentState } = await import("./state.js");
const { buildAgentEventToken } = await import("./event-token.js");

process.env["DEVLET_AUTH_TOKEN"] = "test-secret-for-events";

function sampleState(id: string): AgentState {
  return {
    config: {
      id,
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
  };
}

test("valid event token records mission activity on agent state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devlet-events-"));
  process.env["DEVLET_STATE_DIR"] = dir;
  const id = "evt-1";
  await saveAgentState(sampleState(id));

  const result = await recordAgentEvent({
    agentId: id,
    token: buildAgentEventToken(id),
    event: "mission_started",
    at: "2026-06-01T12:00:00Z",
  });
  assert.equal(result.ok, true);

  const state = await loadAgentState(id);
  assert.equal(state.missionProgress.activity?.state, "started");
  assert.equal(state.missionProgress.activity?.since, new Date("2026-06-01T12:00:00Z").toISOString());
  assert.ok(state.logs.some((l) => l.includes("mission process started")));

  deleteAgentState(id);
  rmSync(dir, { recursive: true, force: true });
});

test("invalid or wrong-agent tokens are rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devlet-events-"));
  process.env["DEVLET_STATE_DIR"] = dir;
  const id = "evt-2";
  await saveAgentState(sampleState(id));

  const bad = await recordAgentEvent({ agentId: id, token: "nope", event: "mission_started" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.statusCode, 401);

  // Token minted for a different agent must not validate for this one
  const wrong = await recordAgentEvent({ agentId: id, token: buildAgentEventToken("other-agent"), event: "mission_started" });
  assert.equal(wrong.ok, false);

  // Unknown agent id → 404 even with a syntactically valid token for it
  const missing = await recordAgentEvent({ agentId: "ghost", token: buildAgentEventToken("ghost"), event: "mission_started" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.statusCode, 404);

  deleteAgentState(id);
  rmSync(dir, { recursive: true, force: true });
});

// Note: agents always have a mission description (schema requires min 1 char),
// so the "no mission → no-op" guard in recordAgentEvent is purely defensive
// and not directly constructible through persisted state.
