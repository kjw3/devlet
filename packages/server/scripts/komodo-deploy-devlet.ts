/**
 * Update the Komodo `devlet` stack from the repo root and redeploy.
 *
 * The stack is Komodo-managed (imported from Portainer, not git-linked), so
 * both its compose file and env must be synced manually:
 * - env: merges missing PROXMOX_/TAILSCALE_/LITELLM_/KOMODO_/DEVLET_ keys from
 *   .env into the stack's managed environment; existing values are never
 *   overwritten (update prod-only secrets via the Komodo UI)
 * - compose: copies the repo's docker-compose.yml into the stack's
 *   file_contents when they differ
 * - then triggers DeployStack (auto_pull pulls fresh ghcr.io/*:latest images)
 *
 * Usage: node --import tsx scripts/komodo-deploy-devlet.ts [--dry-run]
 */
import { readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");

// ── parse repo .env ───────────────────────────────────────────────────────────
const local = new Map<string, string>();
for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  if (v && !local.has(k)) local.set(k, v);
}

// ── komodo client (after env parsing) ────────────────────────────────────────
for (const [k, v] of local) if (!(k in process.env)) process.env[k] = v;
const { getKomodoClient } = await import("../src/platforms/komodo-client.js");
const komodo = getKomodoClient();
if (!komodo) {
  console.error("Komodo is not configured (KOMODO_URL / KOMODO_API_KEY / KOMODO_API_SECRET)");
  process.exit(1);
}

const STACK = "devlet";
const stack = (await komodo.read("GetStack", { stack: STACK })) as Record<string, any>;
const resource = (stack["stack"] ?? stack) as Record<string, any>;
const cfg = (resource["config"] ?? {}) as Record<string, unknown>;
const rawId = resource["_id"];
const stackId = typeof rawId === "object" && rawId !== null ? String(rawId["$oid"] ?? "") : String(rawId ?? STACK);

const currentEnv = String(cfg["environment"] ?? "");
const currentKeys = new Set(
  currentEnv
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => l.slice(0, l.indexOf("=")).trim())
);

// Which keys to bring over from local .env: everything the compose file
// references that is missing from the stack env. Interpolate the compose to
// find referenced vars, falling back to the known PROXMOX_* block.
const composeFile = String(cfg["file_contents"] ?? "");
const referenced = new Set<string>([...composeFile.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(?::-[^}]*)?\}/g)].map((m) => m[1]));
// Keys the devlet compose consumes. Add ALL of these that are missing — even
// ones the cached (possibly stale) compose doesn't reference yet, since the
// git-pulled compose at deploy time will (e.g. PROXMOX_QEMU_STORAGE, PROXMOX_VLAN).
const knownRelevant = [
  ...[...local.keys()].filter(
    (k) => k.startsWith("PROXMOX_") || k.startsWith("TAILSCALE_") || k.startsWith("LITELLM_") || k.startsWith("KOMODO_") || k.startsWith("DEVLET_")
  ),
];
const toAdd = knownRelevant.filter((k) => !currentKeys.has(k));

console.log(`stack "${STACK}" (id ${stackIdShort(stackId)}, server cfg, auto_pull=${cfg["auto_pull"]})`);
console.log(`stack env has ${currentKeys.size} keys; referenced by compose: ${referenced.size}`);
const missing = [...referenced].filter((k) => !currentKeys.has(k));
console.log(`referenced-but-unset: ${missing.length ? missing.join(", ") : "(none)"}`);

function stackIdShort(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

if (toAdd.length === 0) {
  console.log("nothing to add from local .env");
} else {
  console.log(`adding ${toAdd.length} keys: ${toAdd.join(", ")}`);
}

if (dryRun) {
  console.log("dry-run: stack not modified");
  process.exit(0);
}

// Do not interrupt live provisioning, even when restart recovery is available.
// Fail closed if the production preflight cannot establish that deployment is safe.
const productionToken = currentEnv.split("\n").map(l => l.trim())
  .find(l => l.startsWith("DEVLET_AUTH_TOKEN="))?.slice("DEVLET_AUTH_TOKEN=".length).replace(/^["']|["']$/g, "");
if (!productionToken) throw new Error("Deployment preflight: production auth token is missing");
const response = await fetch("http://devlet-server:3001/trpc/agents.list", {
  headers: { Authorization: `Bearer ${productionToken}` }, signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Deployment preflight failed (HTTP ${response.status})`);
const payload = await response.json() as { result?: { data?: Array<{ status: string; config: { id: string } }> } };
if (!Array.isArray(payload.result?.data)) throw new Error("Deployment preflight returned an unexpected response");
const provisioning = payload.result.data.filter(agent => agent.status === "provisioning");
if (provisioning.length) throw new Error(`Deployment blocked: agents still provisioning: ${provisioning.map(a => a.config.id).join(", ")}. Wait for completion before redeploying.`);
console.log("→ preflight: no agents provisioning");

// ── sync compose file ─────────────────────────────────────────────────────────
const repoCompose = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
if (composeFile.trimEnd() !== repoCompose.trimEnd()) {
  await komodo.write("UpdateStack", { id: stackId, config: { file_contents: repoCompose } });
  console.log("→ stack compose synced from repo docker-compose.yml");
} else {
  console.log("→ stack compose already in sync");
}

// ── sync env ──────────────────────────────────────────────────────────────
if (toAdd.length > 0) {
  const merged = `${currentEnv}${currentEnv.endsWith("\n") || currentEnv === "" ? "" : "\n"}${toAdd.map((k) => `${k}=${local.get(k)}`).join("\n")}\n`;
  await komodo.write("UpdateStack", { id: stackId, config: { environment: merged } });
  console.log(`→ stack env updated (+${toAdd.length})`);
} else {
  console.log("→ stack env unchanged");
}

console.log("→ deploying stack (compose pull + up)...");
const update = (await komodo.execute("DeployStack", { stack: STACK })) as Record<string, unknown>;
console.log(`deploy update: ${update["status"] ?? update["_id"] ?? "triggered"}`);
