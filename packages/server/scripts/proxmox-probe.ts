// Live Proxmox verification probe (docs/proxmox-provisioning.md, P3).
//
// Run from packages/server:
//   node --import tsx scripts/proxmox-probe.ts
//
// Reads ../../.env for PROXMOX_* variables (existing process env wins).
import { readFileSync } from "node:fs";
import path from "node:path";

// Minimal .env loader — existing process env takes precedence.
function loadDotEnv(): void {
  if (process.env["PROXMOX_URL"]) return;
  try {
    const envPath = path.resolve(import.meta.dirname ?? ".", "../../../.env");
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // no .env — rely on process env
  }
}
loadDotEnv();

const { config } = await import("../src/config.js");
const {
  pveGet,
  listClusterGuests,
  listStorageContent,
  countGpuDevices,
  getNextVmid,
  allocateVmid,
  devletGuestName,
} = await import("../src/platforms/proxmox-client.js");
const { inferNodeArchitecture } = await import("../src/platforms/proxmox.js");

let failures = 0;
const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const warn = (msg: string) => console.log(`  ⚠ ${msg}`);
const fail = (msg: string) => {
  failures += 1;
  console.log(`  ✘ ${msg}`);
};

async function attempt(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    fail(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("── Proxmox probe ──────────────────────────────────────────────");
if (!config.proxmox.url || !config.proxmox.user || !config.proxmox.tokenSecret) {
  console.log("✘ PROXMOX_URL / PROXMOX_USER / PROXMOX_TOKEN_ID / PROXMOX_TOKEN_SECRET not set");
  console.log("  Add them to .env (see .env.example) and re-run this probe.");
  process.exit(1);
}
console.log(`URL: ${config.proxmox.url}`);
console.log(`User: ${config.proxmox.user}  Token: ${config.proxmox.tokenId}`);
console.log(`Node: ${config.proxmox.node || "(unset)"}  Storage: ${config.proxmox.storage}`);
console.log(`LXC template: ${config.proxmox.lxcTemplate || "(unset)"}`);
console.log(`QEMU template: ${config.proxmox.qemuTemplateId || "(unset)"}`);
console.log(`QEMU GPU template: ${config.proxmox.qemuGpuTemplateId || "(unset — falls back to the QEMU template)"}`);
console.log("");

await attempt("GET /version", async () => {
  const version = await pveGet<{ version: string; release: string }>("/version");
  ok(`PVE ${version.version} (release ${version.release})`);
});

interface ApiNode {
  node: string;
  status: string;
}
let nodes: ApiNode[] = [];
await attempt("GET /nodes", async () => {
  nodes = await pveGet<ApiNode[]>("/nodes");
  ok(`${nodes.length} node(s): ${nodes.map((n) => `${n.node} (${n.status})`).join(", ")}`);
});

for (const node of nodes.filter((n) => n.status === "online")) {
  await attempt(`architecture on ${node.node}`, async () => {
    const status = await pveGet<{ arch?: string; cpuinfo?: { arch?: string; flags?: string; model?: string } }>(
      `/nodes/${encodeURIComponent(node.node)}/status`
    );
    const arch = inferNodeArchitecture(status as never);
    const model = status.cpuinfo?.model ?? "unknown cpu";
    console.log(`  · ${node.node} arch: ${arch} (${model})`);
  });
  await attempt(`GPU detection on ${node.node}`, async () => {
    const gpus = await countGpuDevices(node.node);
    console.log(`  · ${node.node} GPU-class devices: ${gpus}`);
  });
}

await attempt("guest listing (cluster/resources)", async () => {
  const guests = await listClusterGuests();
  ok(`${guests.length} guest(s) visible cluster-wide`);
  const devlet = guests.filter((g) => g.name?.startsWith("devlet-"));
  if (devlet.length > 0) {
    console.log(`  · Devlet guests: ${devlet.map((g) => `${g.name} (${g.type} ${g.vmid}, ${g.node})`).join(", ")}`);
  }
});

await attempt("storage content read (template discovery)", async () => {
  const node = config.proxmox.node || nodes.find((n) => n.status === "online")?.node;
  if (!node) throw new Error("no online node to check storage on");
  // The template volid names its own storage; guest disks use PROXMOX_STORAGE.
  const templateStorage = config.proxmox.lxcTemplate.split(":")[0] || config.proxmox.storage;
  const content = await listStorageContent(node, templateStorage, "vztmpl");
  const templates = content.map((c) => c.volid);
  if (templates.length === 0) {
    warn(`no LXC templates in storage "${templateStorage}" on ${node}`);
  } else {
    ok(`${templates.length} LXC template(s) in ${templateStorage}: ${templates.join(", ")}`);
  }
  if (config.proxmox.lxcTemplate && !templates.includes(config.proxmox.lxcTemplate)) {
    fail(`configured PROXMOX_LXC_TEMPLATE "${config.proxmox.lxcTemplate}" not in storage content`);
  } else if (config.proxmox.lxcTemplate) {
    ok(`configured LXC template present`);
  }
});

if (config.proxmox.qemuTemplateId) {
  await attempt(`QEMU template ${config.proxmox.qemuTemplateId}`, async () => {
    const guests = await listClusterGuests();
    const template = guests.find((g) => g.vmid === config.proxmox.qemuTemplateId);
    if (!template) throw new Error(`VM ${config.proxmox.qemuTemplateId} not found`);
    if (template.template !== 1) throw new Error(`VM ${config.proxmox.qemuTemplateId} is not a template`);
    ok(`QEMU template ${templateIdLabel(template.vmid)} on ${template.node}`);
  });
} else {
  warn("PROXMOX_QEMU_TEMPLATE_ID not set — VM (QEMU/GPU/nanoclaw) placement unavailable");
}

if (config.proxmox.qemuGpuTemplateId) {
  await attempt(`QEMU GPU template ${config.proxmox.qemuGpuTemplateId}`, async () => {
    const guests = await listClusterGuests();
    const template = guests.find((g) => g.vmid === config.proxmox.qemuGpuTemplateId);
    if (!template) throw new Error(`VM ${config.proxmox.qemuGpuTemplateId} not found`);
    if (template.template !== 1) throw new Error(`VM ${config.proxmox.qemuGpuTemplateId} is not a template`);
    ok(`QEMU GPU template ${templateIdLabel(template.vmid)} on ${template.node}`);
  });
}

await attempt("nextid + VMID allocation dry-run", async () => {
  const next = await getNextVmid();
  console.log(`  · cluster nextid: ${next ?? "(unavailable)"}`);
  const alloc = await allocateVmid("probe-agent-dryrun");
  console.log(`  · would place "probe-agent-dryrun" (${devletGuestName("probe-agent-dryrun")}) at VMID ${alloc.vmid}${alloc.existingGuest ? " (existing guest)" : ""}`);
});

console.log("");
console.log(
  failures === 0
    ? "All checks passed — Proxmox is ready for provisioning (hire an agent to verify end-to-end)."
    : `${failures} check(s) failed — see above.`
);
process.exit(failures === 0 ? 0 : 1);

function templateIdLabel(id: number): string {
  return `#${id}`;
}
