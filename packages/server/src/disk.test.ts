import assert from "node:assert/strict";
import { test } from "node:test";
import { agentDiskMaximumGb, BYTES_PER_GB, diskMaximumGb, diskSizeError, templateDiskGb, HireAgentInputSchema, ResourceLimitsSchema } from "@devlet/shared";

test("free-space maximum floors to whole GB and subtracts reserves and pending hires", () => {
  assert.equal(diskMaximumGb(100.9 * BYTES_PER_GB, 10, 20), 70);
  assert.equal(diskMaximumGb(5 * BYTES_PER_GB, 10), 0);
});
test("policy caps even very large shared pools and validates administrator overrides", () => {
  assert.equal(diskMaximumGb(16000 * BYTES_PER_GB, 10), 100);
  assert.equal(diskMaximumGb(16000 * BYTES_PER_GB, 10, 0, 200), 200);
  assert.equal(agentDiskMaximumGb(undefined), 100);
  assert.equal(agentDiskMaximumGb("200"), 200);
  for (const value of ["9", "1.5", "NaN", "Infinity", "-1"]) assert.throws(() => agentDiskMaximumGb(value));
  assert.ok(diskSizeError(101, { supported: true, minimumGb: 10, maximumGb: 1000, policyMaximumGb: 100 }));
});
test("disk validation rejects fractional, undersized, oversized, and unknown capacity requests", () => {
  const capacity = { supported: true, minimumGb: 20, maximumGb: 50 };
  assert.equal(diskSizeError(20, capacity), undefined);
  for (const gb of [19, 20.5, 51, NaN, Infinity]) assert.ok(diskSizeError(gb, capacity));
  assert.ok(diskSizeError(20, { supported: true, minimumGb: 20 }));
  assert.ok(diskSizeError(20, { supported: false, minimumGb: 10 }));
});
test("template size supports PVE units and fails closed when root size is unknown", () => {
  assert.equal(templateDiskGb({ scsi0: "ceph:base-disk,size=16G" }), 16);
  assert.equal(templateDiskGb({ virtio0: "ceph:base-disk,size=1T" }), 1024);
  assert.equal(templateDiskGb({ sata0: "local:disk,size=21504M,ssd=1" }), 21);
  assert.throws(() => templateDiskGb({ scsi0: "ceph:disk" }));
});
test("whole GB enforced only on new hires, stored legacy MB sizes remain readable", () => {
  const input = { name: "test", type: "pi", role: "test", mission: { description: "test", steps: [], onComplete: "terminate" }, env: {}, persistent: false };
  assert.equal(HireAgentInputSchema.safeParse({ ...input, resources: { cpus: 1, memoryMb: 1024, storageMb: 10241 } }).success, false);
  assert.equal(HireAgentInputSchema.safeParse({ ...input, resources: { cpus: 1, memoryMb: 1024, storageMb: 20480 } }).success, true);
  assert.equal(ResourceLimitsSchema.safeParse({ cpus: 1, memoryMb: 1024, storageMb: 10241 }).success, true);
});
