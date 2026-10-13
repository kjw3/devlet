import type { AgentConfig, TailscaleStatus } from "@devlet/shared";
import { config } from "../config.js";

/**
 * Tailscale control-plane client (OAuth client-credentials).
 *
 * The server holds only the OAuth client; each agent gets its own single-use,
 * ephemeral, pre-authorized auth key minted at provision time.
 */

const API = "https://api.tailscale.com/api/v2";
const KEY_EXPIRY_SECONDS = 3600; // covers slow image pulls before the container starts
const DEVICE_CACHE_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface TailnetDevice {
  id: string;
  name: string; // MagicDNS FQDN
  hostname: string;
  addresses: string[];
  tags: string[];
  connectedToControl: boolean;
}

interface OAuthCreds {
  clientId: string;
  clientSecret: string;
}

const tokenCache = new Map<string, { value: string; expiresAt: number }>();
let deviceCache: { ts: number; devices: TailnetDevice[] } | null = null;

export function isTailscaleConfigured(): boolean {
  return Boolean(config.tailscale.clientId && config.tailscale.clientSecret);
}

/** Per-agent opt-out: env DEVLET_TAILSCALE=false (or default-off + not set to true). */
export function isTailscaleEnabledFor(agentConfig: AgentConfig): boolean {
  if (!isTailscaleConfigured()) return false;
  const flag = agentConfig.env["DEVLET_TAILSCALE"];
  if (flag === "true") return true;
  if (flag === "false") return false;
  return config.tailscale.defaultEnabled;
}

export function tailnetHostnameFor(agentId: string): string {
  return `devlet-${agentId}`.toLowerCase();
}

async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body && !(init.body instanceof URLSearchParams) ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tailscale API ${init.method ?? "GET"} ${path} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

const AGENT_CREDS = (): OAuthCreds => ({
  clientId: config.tailscale.clientId,
  clientSecret: config.tailscale.clientSecret,
});

export const SERVER_CREDS = (): OAuthCreds => ({
  clientId: config.tailscale.serverClientId,
  clientSecret: config.tailscale.serverClientSecret,
});

async function getAccessToken(creds: OAuthCreds = AGENT_CREDS()): Promise<string> {
  const cached = tokenCache.get(creds.clientId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.value;
  const body = await api<{ access_token: string; expires_in: number }>("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "client_credentials",
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  tokenCache.set(creds.clientId, { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

/** Mint a single-use, ephemeral, pre-authorized, tagged auth key. */
export async function mintAgentAuthKey(
  tag: string = config.tailscale.tag,
  creds: OAuthCreds = AGENT_CREDS()
): Promise<string> {
  const token = await getAccessToken(creds);
  const res = await api<{ key: string }>(
    `/tailnet/${encodeURIComponent(config.tailscale.tailnet)}/keys`,
    {
      method: "POST",
      body: JSON.stringify({
        capabilities: {
          devices: {
            create: {
              reusable: false,
              ephemeral: true,
              preauthorized: true,
              tags: [tag],
            },
          },
        },
        expirySeconds: KEY_EXPIRY_SECONDS,
        description: "devlet agent",
      }),
    },
    token
  );
  return res.key;
}

export async function listTailnetDevices(options: { fresh?: boolean } = {}): Promise<TailnetDevice[]> {
  if (!options.fresh && deviceCache && Date.now() - deviceCache.ts < DEVICE_CACHE_MS) {
    return deviceCache.devices;
  }
  const token = await getAccessToken();
  const res = await api<{ devices?: TailnetDevice[] }>(
    `/tailnet/${encodeURIComponent(config.tailscale.tailnet)}/devices?fields=default`,
    {},
    token
  );
  const devices = (res.devices ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    hostname: d.hostname,
    addresses: d.addresses ?? [],
    tags: d.tags ?? [],
    connectedToControl: Boolean(d.connectedToControl),
  }));
  deviceCache = { ts: Date.now(), devices };
  return devices;
}

/** Find the online node for an agent, if it has joined the tailnet. */
export async function findAgentDevice(agentId: string): Promise<TailnetDevice | null> {
  const hostname = tailnetHostnameFor(agentId);
  const devices = await listTailnetDevices();
  return (
    devices.find(
      (d) =>
        d.hostname.toLowerCase() === hostname &&
        d.tags.includes(config.tailscale.tag) &&
        d.connectedToControl
    ) ?? null
  );
}

/**
 * Delete any node for this agent (stale ephemeral nodes linger for a while after a
 * container dies and would force the next join to a "-1" suffixed name).
 * Best-effort: never throws.
 */
export async function removeAgentDevices(agentId: string): Promise<void> {
  await removeDevicesByHostname(tailnetHostnameFor(agentId), config.tailscale.tag);
}

export async function removeDevicesByHostname(hostname: string, tag: string): Promise<void> {
  if (!isTailscaleConfigured()) return;
  try {
    const token = await getAccessToken();
    const devices = await listTailnetDevices({ fresh: true });
    const matches = devices.filter(
      (d) => d.hostname.toLowerCase() === hostname && d.tags.includes(tag)
    );
    await Promise.all(
      matches.map((d) => api(`/device/${encodeURIComponent(d.id)}`, { method: "DELETE" }, token))
    );
    if (matches.length > 0) deviceCache = null;
  } catch (error) {
    console.warn(`[tailscale] device cleanup for ${hostname} failed:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Returns a copy of the agent config with TS_* env injected for this launch.
 * The single-use key is deliberately NOT persisted in saved agent state.
 * On any failure the agent still launches, just without tailnet access.
 */
export async function withTailscaleEnv(agentConfig: AgentConfig): Promise<AgentConfig> {
  if (!isTailscaleEnabledFor(agentConfig)) return agentConfig;
  try {
    await removeAgentDevices(agentConfig.id);
    const authKey = await mintAgentAuthKey();
    return {
      ...agentConfig,
      env: {
        ...agentConfig.env,
        TS_AUTHKEY: authKey,
        TS_HOSTNAME: tailnetHostnameFor(agentConfig.id),
        TS_TAGS: config.tailscale.tag,
        DEVLET_AGENT_ID: agentConfig.id,
      },
    };
  } catch (error) {
    console.warn(`[tailscale] could not prepare tailnet access for ${agentConfig.id}:`, error instanceof Error ? error.message : error);
    return agentConfig;
  }
}

export async function probeTailscale(serverOnTailnet = false): Promise<TailscaleStatus> {
  if (!isTailscaleConfigured()) return { configured: false, connected: false };
  try {
    const devices = await listTailnetDevices({ fresh: true });
    return {
      configured: true,
      connected: true,
      serverOnTailnet,
      agentNodes: devices.filter((d) => d.tags.includes(config.tailscale.tag) && d.connectedToControl).length,
    };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
