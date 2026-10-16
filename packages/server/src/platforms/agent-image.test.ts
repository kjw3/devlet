import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_IMAGE, agentImageFor } from "./docker.js";
import { gpuDeviceRequests } from "./hardware.js";
import type { AgentConfig } from "@devlet/shared";

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "a1",
    name: "a1",
    type: "claude-code",
    role: "dev",
    mission: { prompt: "x", onComplete: "persist" },
    platform: { type: "docker" },
    resources: { cpus: 1, memoryMb: 2048 },
    env: {},
    persistent: false,
    createdAt: "",
    lastActiveAt: "",
    ...overrides,
  } as AgentConfig;
}

test("gpu-required coding agents get the GPU layer image", () => {
  process.env["AGENT_IMAGE_GPU"] = "localhost/devlet-agent-gpu:test";
  try {
    assert.equal(agentImageFor(config({ gpu: { required: true } })), "localhost/devlet-agent-gpu:test");
  } finally {
    delete process.env["AGENT_IMAGE_GPU"];
  }
  // Default when the override is unset/empty (docker-compose passes empty strings).
  assert.equal(agentImageFor(config({ gpu: { required: true } })), "ghcr.io/kjw3/devlet-agent-gpu:latest");
});

test("agents without GPU requirements keep their normal image", () => {
  assert.equal(agentImageFor(config()), AGENT_IMAGE["claude-code"]);
  assert.equal(agentImageFor(config({ gpu: { required: false } })), AGENT_IMAGE["claude-code"]);
});

test("gateway agents keep their own image even when a GPU is required", () => {
  assert.equal(agentImageFor(config({ type: "openclaw", gpu: { required: true } })), AGENT_IMAGE["openclaw"]);
});

test("DeviceRequests asks for all NVIDIA GPUs with compute + utility", () => {
  const [req] = gpuDeviceRequests();
  assert.equal(req!.Driver, "nvidia");
  assert.equal(req!.Count, -1); // all GPUs
  assert.deepEqual(req!.Capabilities, [["gpu", "compute", "utility"]]);
});
