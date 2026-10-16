// Unit tests for the Proxmox guest NIC handling in proxmox-deploy.ts
// (readdressNet0 / freshMac) — run with:
//   node --import tsx --test src/platforms/proxmox-deploy.test.ts
//
// PROXMOX_* env vars are set BEFORE importing the module: config.ts reads them
// once at module load.
process.env["PROXMOX_URL"] ??= "https://pve.test:8006";
process.env["PROXMOX_USER"] ??= "test@pam";
process.env["PROXMOX_TOKEN_ID"] ??= "test";
process.env["PROXMOX_TOKEN_SECRET"] ??= "00000000-0000-0000-0000-000000000000";
process.env["PROXMOX_VLAN"] = "1110";
process.env["PROXMOX_BRIDGE"] = "vmbr0";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentConfig } from "@devlet/shared";
const { freshMac, readdressNet0, buildBootstrapScript } = await import("./proxmox-deploy.js");

it("bootstrap locks before installation and retains existing containers before pulling or launching", async () => {
  const config: AgentConfig = { id: "test", name: "test", type: "pi", role: "test", platform: { type: "proxmox", node: "n", vmType: "lxc" }, resources: { cpus: 1, memoryMb: 1024 }, mission: { description: "test", steps: [], onComplete: "terminate" }, env: {}, persistent: false, createdAt: "", lastActiveAt: "" };
  const script = await buildBootstrapScript(config);
  assert.ok(script.indexOf("flock -w") < script.indexOf("apt-get"));
  assert.ok(script.indexOf('if [ -n "$existing" ]') < script.indexOf("docker pull"));
  assert.ok(script.indexOf("docker pull") < script.indexOf("docker run"));
  assert.ok(!script.includes("docker rm"));
  assert.ok(!script.includes("docker start"));
});

const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const TEMPLATE_NET0 = "virtio=BC:24:11:3D:A3:5A,bridge=vmbr0,firewall=1,tag=2100";

describe("freshMac", () => {
  it("returns a valid unicast MAC in PVE's BC:24:11 range", () => {
    const mac = freshMac();
    assert.match(mac, MAC_RE);
    assert.ok(mac.startsWith("BC:24:11:"));
  });

  it("never repeats the template's or a previous MAC", () => {
    const seen = new Set([freshMac(), freshMac(), freshMac(), freshMac(), freshMac()]);
    assert.equal(seen.size, 5);
    assert.ok(!seen.has("BC:24:11:3D:A3:5A"));
  });
});

describe("readdressNet0 (PROXMOX_VLAN=1110)", () => {
  it("keeps bridge/model/firewall, swaps the MAC, overrides the template VLAN", () => {
    const net0 = readdressNet0(TEMPLATE_NET0);
    const parts = net0.split(",");
    assert.ok(parts.includes("bridge=vmbr0"));
    assert.ok(parts.includes("firewall=1"));
    assert.ok(parts.includes("tag=1110"), "template tag=2100 must be replaced by PROXMOX_VLAN");
    assert.ok(!net0.includes("2100"));
    const model = parts[0]?.split("=") ?? [];
    assert.equal(model[0], "virtio");
    assert.match(model[1] ?? "", MAC_RE);
    assert.notEqual(model[1] ?? "", "BC:24:11:3D:A3:5A");
  });

  it("appends the VLAN when the template net0 has no tag", () => {
    const net0 = readdressNet0("virtio=BC:24:11:3D:A3:5A,bridge=vmbr0,firewall=1");
    assert.ok(net0.endsWith(",tag=1110"));
    assert.ok(net0.includes("bridge=vmbr0"));
  });

  it("builds a fallback net0 when the template has none", () => {
    const net0 = readdressNet0("");
    const parts = net0.split(",");
    assert.equal(parts[0], `virtio=${parts[0]?.split("=")[1]}`);
    assert.match(parts[0]?.split("=")[1] ?? "", MAC_RE);
    assert.ok(parts.includes("bridge=vmbr0"));
    assert.ok(parts.includes("tag=1110"));
  });

  it("produces a different MAC for every guest", () => {
    const a = readdressNet0(TEMPLATE_NET0);
    const b = readdressNet0(TEMPLATE_NET0);
    assert.notEqual(a.split(",")[0], b.split(",")[0]);
    assert.notEqual(a, b);
  });
});
