import http from "node:http";
import https from "node:https";
import { config } from "../config.js";

// ─── Overview ──────────────────────────────────────────────────────────────────
// Thin Proxmox VE API client used by discovery (proxmox.ts) and provisioning
// (proxmox-deploy.ts). Design notes:
//
//   • Auth: PVE API token header `PVEAPIToken=user@realm!tokenid=secret`.
//     PROXMOX_USER may already include `!tokenid` — handled in authHeaders().
//   • Bodies: PVE expects application/x-www-form-urlencoded for POST/PUT.
//   • Responses: successful calls wrap the payload in `{ data: ... }`.
//   • Long operations (create/clone/start/stop) return a UPID task id; use
//     waitForTask() to poll it to completion and surface the task log on error.
//   • The transport is injectable so tests can stub HTTP without a live PVE.

export interface ProxmoxResponse {
  status: number;
  body: string;
}

export interface ProxmoxTransport {
  request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    headers: Record<string, string>,
    body?: string,
    insecure?: boolean
  ): Promise<ProxmoxResponse>;
}

class HttpProxmoxTransport implements ProxmoxTransport {
  request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    headers: Record<string, string>,
    body?: string,
    insecure?: boolean
  ): Promise<ProxmoxResponse> {
    return new Promise((resolve, reject) => {
      const isHttps = url.startsWith("https:");
      const transport = isHttps ? https : http;
      const req = transport.request(
        url,
        {
          method,
          headers,
          ...(isHttps ? { rejectUnauthorized: !insecure } : {}),
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 500, body: data });
          });
        }
      );
      req.on("error", reject);
      req.setTimeout(30_000, () => {
        req.destroy(new Error(`Proxmox API request timed out: ${method} ${url}`));
      });
      if (body) req.write(body);
      req.end();
    });
  }
}

let transport: ProxmoxTransport = new HttpProxmoxTransport();

/** Swap the HTTP transport (tests only). Returns the previous transport. */
export function setProxmoxTransportForTests(next: ProxmoxTransport): ProxmoxTransport {
  const previous = transport;
  transport = next;
  return previous;
}

// ─── Credentials / auth ────────────────────────────────────────────────────────

export interface ProxmoxCredentials {
  url: string;
  tokenIdentifier: string;
  tokenSecret: string;
  insecure: boolean;
}

export function isProxmoxConfigured(): boolean {
  const { url, user, tokenId, tokenSecret } = config.proxmox;
  return Boolean(url && user && tokenId && tokenSecret);
}

function buildTokenAuth(
  user: string,
  tokenId: string,
  tokenSecret: string,
  insecure: boolean
): { headers: Record<string, string>; creds: ProxmoxCredentials } | null {
  const { url } = config.proxmox;
  if (!url) return null;
  // PVE API token auth header format: PVEAPIToken=user@realm!tokenid=secret.
  // PROXMOX_USER may already include !tokenid (e.g. "aiagent@pam!aiagent");
  // PROXMOX_TOKEN_ID may redundantly repeat "user@realm!" — strip that too.
  const tokenName = tokenId.includes("!") ? tokenId.slice(tokenId.lastIndexOf("!") + 1) : tokenId;
  const tokenIdentifier = user.includes("!") ? user : `${user}!${tokenName}`;
  return {
    headers: { Authorization: `PVEAPIToken=${tokenIdentifier}=${tokenSecret}` },
    creds: { url: url.replace(/\/+$/, ""), tokenIdentifier, tokenSecret, insecure },
  };
}

/** Build the auth header exactly as discovery does. Null when unconfigured. */
export function authHeaders(): { headers: Record<string, string>; creds: ProxmoxCredentials } | null {
  const { user, tokenId, tokenSecret, insecure } = config.proxmox;
  if (!user || !tokenId || !tokenSecret) return null;
  return buildTokenAuth(user, tokenId, tokenSecret, insecure);
}

/**
 * Optional root@pam credential used only for PVE root-only operations
 * (GPU hostpci passthrough). Null when not configured.
 */
export function rootAuthHeaders(): { headers: Record<string, string>; creds: ProxmoxCredentials } | null {
  const { rootUser, rootTokenId, rootTokenSecret } = config.proxmox;
  if (!rootUser || !rootTokenId || !rootTokenSecret) return null;
  return buildTokenAuth(rootUser, rootTokenId, rootTokenSecret, config.proxmox.insecure);
}

// ─── Core request helpers ─────────────────────────────────────────────────────

export class ProxmoxApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string
  ) {
    super(message);
    this.name = "ProxmoxApiError";
  }
}

function buildUrl(creds: ProxmoxCredentials, path: string): string {
  return `${creds.url}/api2/json${path}`;
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, string | number | boolean | undefined>,
  auth?: { headers: Record<string, string>; creds: ProxmoxCredentials } | null
): Promise<T> {
  const resolved = auth ?? authHeaders();
  if (!resolved) {
    throw new Error(
      "Proxmox credentials not configured (PROXMOX_URL, PROXMOX_USER, PROXMOX_TOKEN_ID, PROXMOX_TOKEN_SECRET)"
    );
  }
  const { creds, headers } = resolved;

  let encoded: string | undefined;
  if (body) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) params.set(key, String(value));
    encoded = params.toString();
  }

  const requestHeaders: Record<string, string> = { ...headers };
  if (encoded) {
    requestHeaders["Content-Type"] = "application/x-www-form-urlencoded";
    requestHeaders["Content-Length"] = String(Buffer.byteLength(encoded));
  }

  const res = await transport.request(
    method,
    buildUrl(creds, path),
    requestHeaders,
    encoded,
    creds.insecure
  );

  if (res.status >= 400) {
    // PVE error bodies: `{ errors: "..." }` (string), `{ errors: {...} }`
    // (validation map — 400s), `{ message: "..." }` (403/500s), or plain text.
    let detail = res.body;
    try {
      const parsed = JSON.parse(res.body) as { errors?: unknown; message?: unknown };
      if (parsed?.errors) {
        detail = typeof parsed.errors === "string" ? parsed.errors : JSON.stringify(parsed.errors);
      } else if (typeof parsed?.message === "string") {
        detail = parsed.message;
      }
    } catch {
      // keep raw body
    }
    throw new ProxmoxApiError(
      `${method} ${path} → HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      res.status,
      path
    );
  }

  // DELETE/PUT may return an empty body (204 or `{ data: null }`).
  if (!res.body || res.body === "null" || res.body === "{}") return null as T;
  try {
    const parsed = JSON.parse(res.body) as { data?: T };
    return (parsed.data !== undefined ? parsed.data : parsed) as T;
  } catch {
    throw new Error(`Proxmox API returned non-JSON body for ${method} ${path}`);
  }
}

export const pveGet = <T>(path: string) => request<T>("GET", path);
export const pvePost = <T>(path: string, body: Record<string, string | number | boolean>) =>
  request<T>("POST", path, body);
export const pvePut = <T>(path: string, body: Record<string, string | number | boolean>) =>
  request<T>("PUT", path, body);
/** PUT using the optional root@pam credential (for PVE root-only options). */
export const pvePutAsRoot = <T>(path: string, body: Record<string, string | number | boolean>) => {
  const root = rootAuthHeaders();
  if (!root) {
    throw new Error(
      "root@pam API token not configured (PROXMOX_ROOT_USER, PROXMOX_ROOT_TOKEN_ID, PROXMOX_ROOT_TOKEN_SECRET)"
    );
  }
  return request<T>("PUT", path, body, root);
};
export const pveDelete = <T>(path: string) => request<T>("DELETE", path);

// ─── Tasks (UPID) ─────────────────────────────────────────────────────────────
// Format: UPID:<node>:<pid>:<pstart>:<starttime>:<dtype>:<id>:<user>:

export interface ParsedUpid {
  upid: string;
  node: string;
  taskType: string;
}

export function parseUpid(upid: string): ParsedUpid {
  const parts = upid.split(":");
  if (parts.length < 8 || parts[0] !== "UPID") {
    throw new Error(`Malformed Proxmox UPID: ${upid}`);
  }
  return { upid, node: parts[1]!, taskType: parts[5]! };
}

export interface ProxmoxTaskStatus {
  status: "running" | "stopped";
  exitstatus?: string;
}

export class ProxmoxTaskError extends Error {
  constructor(
    message: string,
    public readonly upid: string,
    public readonly taskLog: string[]
  ) {
    super(message);
    this.name = "ProxmoxTaskError";
  }
}

interface ProxmoxTaskLogLine {
  n: number;
  t: string;
}

async function fetchTaskLog(node: string, upid: string, limit = 50): Promise<string[]> {
  try {
    const lines = await pveGet<ProxmoxTaskLogLine[]>(
      `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/log?limit=${limit}`
    );
    return (lines ?? []).map((l) => l.t).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Poll a UPID task until it stops. Throws ProxmoxTaskError (with the task log
 * tail) when the task fails. `timeoutMs` defaults to 10 minutes (full clones
 * of large templates can be slow).
 */
export async function waitForTask(
  upid: string,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<void> {
  const { node } = parseUpid(upid);
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const pollMs = opts.pollMs ?? 1000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const status = await pveGet<ProxmoxTaskStatus>(
      `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`
    );
    if (status.status === "stopped") {
      if (status.exitstatus === "OK") return;
      const log = await fetchTaskLog(node, upid);
      throw new ProxmoxTaskError(
        `Proxmox task failed: ${status.exitstatus ?? "unknown error"}`,
        upid,
        log
      );
    }
    if (Date.now() > deadline) {
      const log = await fetchTaskLog(node, upid, 10);
      throw new ProxmoxTaskError(
        `Proxmox task timed out after ${Math.round(timeoutMs / 1000)}s: ${upid}`,
        upid,
        log
      );
    }
    await sleep(pollMs);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ─── VMIDs ────────────────────────────────────────────────────────────────────
// Devlet guests live in 4100–4999. The base is derived from the agent id so a
// reprovision of the same agent lands on the same VMID (D3).

export const PROXMOX_VMID_BASE = 4100;
export const PROXMOX_VMID_POOL = 900;

export function deriveVmidBase(agentId: string): number {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  return PROXMOX_VMID_BASE + (hash % PROXMOX_VMID_POOL);
}

/** The guest name Devlet uses for an agent — used for conflict checks and reuse. */
export function devletGuestName(agentId: string): string {
  return `devlet-${agentId}`;
}

interface ClusterResource {
  vmid: number;
  name?: string;
  type: "qemu" | "lxc";
  node: string;
  status: string;
  template?: 0 | 1;
}

export async function listClusterGuests(): Promise<ClusterResource[]> {
  const resources = await pveGet<ClusterResource[]>("/cluster/resources?type=vm");
  return resources ?? [];
}

export interface VmidAllocation {
  vmid: number;
  /** A guest named devlet-{agentId} already exists at this VMID — reuse it. */
  existingGuest: { node: string; vmType: "qemu" | "lxc"; vmid: number } | null;
}

/**
 * Pick a VMID for `agentId` (D3). Reuses the VMID of an existing
 * `devlet-{agentId}` guest anywhere in the cluster; otherwise derives the base
 * and probes upward past VMIDs taken by other guests.
 */
export async function allocateVmid(agentId: string): Promise<VmidAllocation> {
  const guests = await listClusterGuests();
  const name = devletGuestName(agentId);

  const existing = guests.find((g) => g.name === name && !g.template);
  if (existing) {
    return {
      vmid: existing.vmid,
      existingGuest: { node: existing.node, vmType: existing.type, vmid: existing.vmid },
    };
  }

  const taken = new Set(guests.map((g) => g.vmid));
  const base = deriveVmidBase(agentId);
  for (let offset = 0; offset < PROXMOX_VMID_POOL; offset++) {
    const candidate = PROXMOX_VMID_BASE + ((base - PROXMOX_VMID_BASE + offset) % PROXMOX_VMID_POOL);
    if (!taken.has(candidate)) return { vmid: candidate, existingGuest: null };
  }
  throw new Error(`No free Proxmox VMID in range ${PROXMOX_VMID_BASE}-${PROXMOX_VMID_BASE + PROXMOX_VMID_POOL - 1}`);
}

/** Fetch PVE's suggested next free VMID (used to sanity-check our allocation). */
export async function getNextVmid(): Promise<number | undefined> {
  try {
    return await pveGet<number>("/cluster/nextid");
  } catch {
    return undefined;
  }
}

// ─── Guest status / IP resolution (D5) ────────────────────────────────────────

export interface LxcInterface {
  name: string;
  inet?: string;
  inet6?: string;
}

/** First global IPv4 of an LXC guest, or null (not up yet / unreachable). */
export async function getLxcGuestIp(node: string, vmid: number): Promise<string | null> {
  try {
    const ifaces = await pveGet<LxcInterface[]>(
      `/nodes/${encodeURIComponent(node)}/lxc/${vmid}/interfaces`
    );
    return firstGlobalIpv4(ifaces?.map((i) => ({ name: i.name, inet: i.inet })));
  } catch {
    return null;
  }
}

interface QemuGuestAgentInterface {
  name?: string;
  "ip-addresses"?: Array<{ "ip-address": string; "ip-address-type": string }>;
}

/** First global IPv4 of a QEMU guest via the qemu-guest-agent, or null. */
export async function getQemuGuestIp(node: string, vmid: number): Promise<string | null> {
  try {
    const result = await pveGet<{ result: QemuGuestAgentInterface[] }>(
      `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/network-get-interfaces`
    );
    const addresses = (result?.result ?? []).flatMap((iface) =>
      (iface["ip-addresses"] ?? [])
        .filter((a) => a["ip-address-type"] === "ipv4")
        .map((a) => ({ name: iface.name ?? "", inet: a["ip-address"] }))
    );
    return firstGlobalIpv4(addresses);
  } catch {
    return null;
  }
}

/** Strip CIDR suffixes and pick the first usable global IPv4 (skip loopback). */
export function firstGlobalIpv4(
  entries: Array<{ name?: string; inet?: string | null }>
): string | null {
  for (const entry of entries ?? []) {
    if (!entry.inet) continue;
    if (entry.name === "lo") continue;
    const ip = entry.inet.split("/")[0]!;
    if (ip === "127.0.0.1") continue;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  }
  return null;
}

// ─── Storage content (template existence, D8 preconditions) ───────────────────

export interface StorageContentEntry {
  volid: string;
  content: string; // "vztmpl" for LXC templates, "qemu" for VM disks/templates
  format?: string;
}

export async function listStorageContent(
  node: string,
  storage: string,
  content?: "vztmpl" | "iso" | "qemu"
): Promise<StorageContentEntry[]> {
  const query = content ? `?content=${content}` : "";
  const entries = await pveGet<StorageContentEntry[]>(
    `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content${query}`
  );
  return entries ?? [];
}

/** True when `template` (e.g. `local:vztmpl/debian-12-standard.tar.zst`) exists. */
export async function lxcTemplateExists(
  node: string,
  storage: string,
  template: string
): Promise<boolean> {
  const entries = await listStorageContent(node, storage, "vztmpl");
  return entries.some((e) => e.volid === template);
}

// ─── Storage info (QEMU clone placement) ───────────────────────────────────

export interface StorageInfo {
  storage: string;
  shared: boolean;
  content: string;
}

/** Storage metadata from a node's view, or null when unknown/unreachable. */
export async function getStorageInfo(node: string, storage: string): Promise<StorageInfo | null> {
  try {
    const storages = await pveGet<Array<Record<string, unknown>>>(
      `/nodes/${encodeURIComponent(node)}/storage`
    );
    const found = (storages ?? []).find((s) => s["storage"] === storage);
    if (!found) return null;
    return {
      storage,
      shared: found["shared"] === 1,
      content: String(found["content"] ?? ""),
    };
  } catch {
    return null;
  }
}

// ─── PCI devices (GPU detection, D6) ──────────────────────────────────────────

export interface PciDevice {
  id: string; // "0000:01:00.0"
  class: string; // "0x030000" (6 hex digits from the API)
  vendor_name?: string;
  device_name?: string;
  iommugroup?: number;
}

/** Display-controller base classes: VGA (0300), 3D (0302), Display (0380).
 *  Deliberately excludes 0x13 "processing accelerator" — AMD chipset dummy
 *  functions report there (Starship/Matisse) without being usable GPUs; real
 *  compute cards (A100 etc.) report 0x0302. */
const GPU_PCI_CLASSES = new Set(["0300", "0302", "0380"]);

function isGpuDevice(d: PciDevice): boolean {
  const raw = (d.class || "").toLowerCase().replace(/^0x/, "");
  if (!GPU_PCI_CLASSES.has(raw.slice(0, 4))) return false;
  // Skip server BMC management graphics (ASPEED) — present on every board,
  // useless for agent workloads.
  if ((d.vendor_name ?? "").toLowerCase().includes("aspeed")) return false;
  return true;
}

export async function listPciDevices(node: string): Promise<PciDevice[]> {
  try {
    // Skip no-iommu noise but keep everything else; the API filters by class.
    const devices = await pveGet<PciDevice[]>(
      `/nodes/${encodeURIComponent(node)}/hardware/pci?pci-class-blacklist=0x0600`
    );
    return devices ?? [];
  } catch {
    return [];
  }
}

/** Number of GPU-class PCI devices on a node (VGA/3D/display controllers,
 *  excluding BMC management graphics). */
export async function countGpuDevices(node: string): Promise<number> {
  const devices = await listPciDevices(node);
  return devices.filter(isGpuDevice).length;
}

/** First GPU-class PCI device id suitable for hostpci0, or null. */
export async function firstGpuPciId(node: string): Promise<string | null> {
  const devices = await listPciDevices(node);
  const gpu = devices.find(isGpuDevice);
  return gpu?.id ?? null;
}

/**
 * PCI ids already referenced by any VM's hostpci* config on a node, mapped to
 * a human-readable owner. GPUs passed through to other guests (running or
 * merely configured) cannot be re-attached — the VM would fail to start with
 * a vfio "device busy"-style error — so GPU placement must skip them.
 */
export async function listHostpciInUse(node: string): Promise<Map<string, string>> {
  const inUse = new Map<string, string>();
  let vms: Array<{ vmid: number; name?: string }> = [];
  try {
    const raw = await pveGet<Array<Record<string, unknown>>>(
      `/nodes/${encodeURIComponent(node)}/qemu`
    );
    vms = (raw ?? []).map((v) => ({
      vmid: Number(v["vmid"]),
      name: typeof v["name"] === "string" ? (v["name"] as string) : undefined,
    }));
  } catch {
    return inUse;
  }
  for (const vm of vms) {
    if (!Number.isFinite(vm.vmid)) continue;
    try {
      const cfg = await pveGet<Record<string, unknown>>(
        `/nodes/${encodeURIComponent(node)}/qemu/${vm.vmid}/config`
      );
      for (const [key, value] of Object.entries(cfg)) {
        if (!/^hostpci\d+$/.test(key) || typeof value !== "string") continue;
        const owner = vm.name ? `VM ${vm.name} (vmid ${vm.vmid})` : `VM ${vm.vmid}`;
        for (const part of value.split(";")) {
          const id = (part.split(",")[0] ?? "").trim().toLowerCase();
          // PVE accepts the full id (0000:2b:00.0) and the slot-only form
          // (0000:2b:00 — function defaults to 0); match on the slot.
          if (/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}(\.[0-9a-f])?$/.test(id)) {
            inUse.set(pciSlotKey(id), owner);
          }
        }
      }
    } catch {
      // unreadable config — cannot attribute, skip this VM
    }
  }
  return inUse;
}

/** Normalize a PCI id to its slot (drop the ".function" suffix, lowercase). */
function pciSlotKey(id: string): string {
  return id.toLowerCase().replace(/\.[0-9a-f]+$/, "");
}

export interface PickedGpu {
  id: string;
  /** Total GPU-class devices on the node. */
  total: number;
  /** How many of those are already assigned to other VMs. */
  busy: number;
}

/**
 * First GPU-class PCI device on the node that is not already assigned to
 * another VM, or null when every GPU is busy / none is present.
 */
export async function pickGpuPciId(node: string): Promise<PickedGpu | null> {
  const [devices, inUse] = await Promise.all([listPciDevices(node), listHostpciInUse(node)]);
  const gpus = devices.filter(isGpuDevice);
  const free = gpus.find((g) => !inUse.has(pciSlotKey(g.id)));
  if (!free) return null;
  const busy = gpus.filter((g) => inUse.has(pciSlotKey(g.id))).length;
  return { id: free.id, total: gpus.length, busy };
}
