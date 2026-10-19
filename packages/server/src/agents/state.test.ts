/**
 * Regression tests for GPU device selection surviving the agent-state
 * persistence lifecycle.
 *
 * Bug (95399a5 follow-up): `normalizeGpu` in state.ts dropped
 * `gpu.devices`, so every load (and therefore every subsequent save) erased
 * the GPU UUIDs picked in the hire wizard. Recovery/rebuild/self-heal then
 * reprovisioned with `--gpus all`, exposing every host GPU instead of the
 * assigned one.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentState } from "@devlet/shared";
import "../platforms/localstorage-shim.js";
const { saveAgentState, loadAgentState, listAgentStates } = await import("./state.js");
const { gpuRunArg, gpuDeviceRequests } = await import("../platforms/hardware.js");
const { recoverInterruptedProvisions } = await import("./provision-recovery.js");
const { reconcilePersistentAgent } = await import("./runtime-reconcile.js");

const SELECTED = ["GPU-e9c1d3e6-091f-241e-67c7-a58c6b38380b"];

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "devlet-state-test-"));
  process.env["DEVLET_STATE_DIR"] = stateDir;
});

afterEach(async () => {
  delete process.env["DEVLET_STATE_DIR"];
  await fs.rm(stateDir, { recursive: true, force: true });
});

/** A persistent Komodo GPU agent mirroring the production repro shape. */
function fixture(): AgentState {
  return {
    config: {
      id: "agent-wpzb",
      name: "aeml-gpu",
      type: "pi",
      role: "ML workstation",
      mission: { description: "train", steps: [], onComplete: "idle" },
      platform: { type: "komodo", serverId: "srv-pc4" },
      resources: { cpus: 8, memoryMb: 32768 },
      gpu: {
        required: true,
        memoryMb: 12288,
        passthroughMode: "container",
        devices: [...SELECTED],
      },
      env: {},
      persistent: true,
      createdAt: "2026-10-16T13:00:00.000Z",
      lastActiveAt: "2026-10-16T13:00:00.000Z",
    },
    status: "running",
    platformRef: "komodo:srv-pc4:devlet-agent-wpzb",
    missionProgress: { currentStep: 0, completed: [], startedAt: "2026-10-16T13:00:00.000Z" },
    logs: [],
  };
}

test("saving and loading a configuration preserves the selected GPU UUID", async () => {
  await saveAgentState(fixture());
  const loaded = await loadAgentState("agent-wpzb");
  assert.deepEqual(loaded.config.gpu, {
    required: true,
    memoryMb: 12288,
    passthroughMode: "container",
    devices: [...SELECTED],
  });
});

test("loading and saving again does not lose the selection (round-trip)", async () => {
  await saveAgentState(fixture());

  // Every runtime flow does load → mutate → save (recovery, rebuild,
  // reconciliation, log appends). Simulate one full cycle.
  const first = await loadAgentState("agent-wpzb");
  first.logs.push("[devlet] persistent agent was stopped or missing — reprovisioned");
  await saveAgentState(first);

  const second = await loadAgentState("agent-wpzb");
  assert.deepEqual(second.config.gpu?.devices, [...SELECTED]);
});

test("listAgentStates preserves the selection and unrelated configuration", async () => {
  await saveAgentState(fixture());
  const listed = await listAgentStates();
  const wpzb = listed.find((s) => s.config.id === "agent-wpzb")!;
  assert.deepEqual(wpzb.config.gpu?.devices, [...SELECTED]);
  // Other gpu fields survive too.
  assert.equal(wpzb.config.gpu?.memoryMb, 12288);
  assert.equal(wpzb.config.gpu?.passthroughMode, "container");
  assert.equal(wpzb.config.gpu?.required, true);
  // Unrelated config is untouched.
  assert.deepEqual(wpzb.config.platform, { type: "komodo", serverId: "srv-pc4" });
  assert.deepEqual(wpzb.config.resources, { cpus: 8, memoryMb: 32768 });
  assert.equal(wpzb.config.persistent, true);
  assert.deepEqual(wpzb.config.mission, { description: "train", steps: [], onComplete: "idle" });
});

test("legacy configurations without an explicit selection keep all-GPU semantics", async () => {
  const legacy = fixture();
  delete legacy.config.gpu?.devices;
  await saveAgentState(legacy);

  const loaded = await loadAgentState("agent-wpzb");
  assert.equal(loaded.config.gpu?.devices, undefined);
  // No selection → deployment still requests all GPUs.
  assert.equal(gpuRunArg(loaded.config.gpu?.devices), "all");
  assert.deepEqual(gpuDeviceRequests(loaded.config.gpu?.devices), [
    { Driver: "nvidia", Count: -1, Capabilities: [["gpu", "compute", "utility"]], Options: {} },
  ]);
});

test("interrupted-provision recovery reprovisions with the same GPU selection", async () => {
  const state = fixture();
  state.status = "provisioning";
  state.platformRef = "pending";
  await saveAgentState(state);

  const snapshots = await listAgentStates();
  let provisionedConfig: AgentState["config"] | undefined;
  await recoverInterruptedProvisions(snapshots, {
    load: loadAgentState,
    save: saveAgentState,
    provision: async (config) => {
      provisionedConfig = structuredClone(config);
      return "komodo:srv-pc4:devlet-agent-wpzb";
    },
  });

  assert.ok(provisionedConfig, "recovery must reprovision");
  assert.deepEqual(provisionedConfig.gpu?.devices, [...SELECTED]);
  // The resulting deployment requests the selected UUID, not all GPUs.
  assert.equal(gpuRunArg(provisionedConfig.gpu?.devices), `device=${SELECTED[0]}`);
  const requests = gpuDeviceRequests(provisionedConfig.gpu?.devices);
  assert.deepEqual(requests[0]?.DeviceIDs, [...SELECTED]);
  assert.equal(requests[0]?.Count, undefined);

  // And the persisted state still carries the selection after recovery.
  const persisted = await loadAgentState("agent-wpzb");
  assert.deepEqual(persisted.config.gpu?.devices, [...SELECTED]);
  assert.equal(persisted.status, "running");
});

test("persistent-agent self-heal reprovisioning keeps the selection", async () => {
  const state = fixture();
  state.status = "error"; // node went offline while agent was down
  await saveAgentState(state);

  // Same wiring as index.ts syncAgentStatuses: list → reconcile → provision.
  const states = await listAgentStates();
  const wpzb = states.find((s) => s.config.id === "agent-wpzb")!;
  let provisionedConfig: AgentState["config"] | undefined;
  await reconcilePersistentAgent(wpzb, false, {
    provision: async () => {
      provisionedConfig = structuredClone(wpzb.config);
      return "komodo:srv-pc4:devlet-agent-wpzb";
    },
    save: saveAgentState,
  });

  assert.ok(provisionedConfig, "self-heal must reprovision");
  assert.deepEqual(provisionedConfig.gpu?.devices, [...SELECTED]);
  assert.equal(gpuRunArg(provisionedConfig.gpu?.devices), `device=${SELECTED[0]}`);

  const persisted = await loadAgentState("agent-wpzb");
  assert.deepEqual(persisted.config.gpu?.devices, [...SELECTED]);
  assert.equal(persisted.status, "running");
});
