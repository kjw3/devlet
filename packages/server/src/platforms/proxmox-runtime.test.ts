import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectGuestRuntime } from "./proxmox-runtime.js";

for (const [output, expected] of [
  ["running\n", true], ["restarting\n", true], ["exited\n", false],
  ["dead\n", false], ["created\n", false], ["", "missing"],
  ["paused\n", null], ["removing\n", null], ["unexpected", null],
] as const) {
  test(`guest runtime ${JSON.stringify(output)} => ${expected}`, async () => {
    assert.equal(await inspectGuestRuntime("192.0.2.1", async (_ip, script, opts) => {
      assert.match(script, /name=\^\/devlet-agent\$/);
      assert.equal(opts?.timeoutMs, 10_000);
      return { stdout: output, stderr: "" };
    }), expected);
  });
}
test("SSH or Docker failure is unknown, not task completion", async () => {
  assert.equal(await inspectGuestRuntime("192.0.2.1", async () => {
    throw new Error("Docker daemon unreachable");
  }), null);
});
