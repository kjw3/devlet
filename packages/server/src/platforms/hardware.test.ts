import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerGpuCount, gpuDeviceRequests, normalizeArchitecture, parseNvidiaInventory } from "./hardware.js";

test("architecture aliases are consistent across platforms", () => {
  assert.equal(normalizeArchitecture("x86_64"), "amd64");
  assert.equal(normalizeArchitecture("aarch64"), "arm64");
  assert.equal(normalizeArchitecture(undefined), "unknown");
});
test("Docker counts unique advertised GPUs, never guesses from runtime presence", () => {
  assert.equal(dockerGpuCount({}), undefined);
  assert.equal(dockerGpuCount({ GenericResources: ["a", "b", "a"].map(Value => ({ NamedResourceSpec: { Kind: "NVIDIA-GPU", Value } })) }), 2);
});
test("Komodo counts physical GPUs, not MIG devices or terminal noise", () => {
  const out = "GPU 0: NVIDIA A100 (UUID: GPU-a)\n MIG 1g.5gb Device 0: (UUID: MIG-a)\nGPU 1: NVIDIA A100 (UUID: GPU-b)\n__KOMODO_EXIT_CODE:0";
  assert.deepEqual(parseNvidiaInventory(out), {
    gpuCount: 2,
    gpuModel: "NVIDIA A100",
    gpuDevices: [
      { id: "GPU-a", model: "NVIDIA A100" },
      { id: "GPU-b", model: "NVIDIA A100" },
    ],
  });
});
test("gpuDeviceRequests: specific ids map to DeviceIDs, no ids means all GPUs", () => {
  assert.deepEqual(gpuDeviceRequests(["GPU-aaa", "GPU-bbb"]), [
    { Driver: "nvidia", DeviceIDs: ["GPU-aaa", "GPU-bbb"], Capabilities: [["gpu", "compute", "utility"]], Options: {} },
  ]);
  assert.deepEqual(gpuDeviceRequests(), [
    { Driver: "nvidia", Count: -1, Capabilities: [["gpu", "compute", "utility"]], Options: {} },
  ]);
  assert.deepEqual(gpuDeviceRequests([]), gpuDeviceRequests());
});
