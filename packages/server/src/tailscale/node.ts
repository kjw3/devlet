import { spawn, execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { AgentAccessSurface } from "../agent-access.js";
import { loadAgentState } from "../agents/state.js";
import { config } from "../config.js";
import {
  findAgentDevice,
  isTailscaleConfigured,
  mintAgentAuthKey,
  removeDevicesByHostname,
  SERVER_CREDS,
} from "./client.js";

/**
 * The Devlet server's own tailnet node (userspace networking, no tun/NET_ADMIN).
 *
 * It exists so the agent-access proxy can reach agents over the tailnet when the
 * platform host's address is unreachable from the server (NAT, containerised host agent,
 * unmapped Komodo server, …). Outbound tailnet traffic goes through tailscaled's local
 * SOCKS5 listener.
 */

const execFileAsync = promisify(execFile);
const SOCKS_ADDR = "127.0.0.1:1055";
const SOCKET = "/tmp/devlet-tailscaled.sock";
const STATE_DIR = "/tmp/devlet-tailscale";
const SERVER_HOSTNAME = "devlet-server";

// Container-side ports of each proxied surface (served on the tailnet by devlet-tailscale).
const FIXED_SURFACE_PORTS: Partial<Record<AgentAccessSurface, number>> = {
  openclaw: 18789,
  moltis: 13131,
};

let socksAgent: SocksProxyAgent | null = null;

export function isServerOnTailnet(): boolean {
  return socksAgent !== null;
}

export async function startServerTailnetNode(): Promise<void> {
  if (!isTailscaleConfigured() || !config.tailscale.serverEnabled) return;
  if (!config.tailscale.serverClientId || !config.tailscale.serverClientSecret) {
    console.log(
      "[tailscale] server tailnet node disabled — set TAILSCALE_SERVER_OAUTH_CLIENT_ID/SECRET " +
        `(an OAuth client with only ${config.tailscale.serverTag}) to proxy agents over the tailnet`
    );
    return;
  }
  try {
    await removeDevicesByHostname(SERVER_HOSTNAME, config.tailscale.serverTag);
    const authKey = await mintAgentAuthKey(config.tailscale.serverTag, SERVER_CREDS());

    const daemon = spawn(
      "tailscaled",
      [
        "--tun=userspace-networking",
        `--statedir=${STATE_DIR}`,
        `--socket=${SOCKET}`,
        `--socks5-server=${SOCKS_ADDR}`,
      ],
      { stdio: "ignore" }
    );
    daemon.on("error", (error) => {
      console.warn(`[tailscale] tailscaled failed to start: ${error.message}`);
    });
    daemon.on("exit", () => {
      socksAgent = null;
    });
    // Give the daemon a moment to open its socket before `up`.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await execFileAsync(
      "tailscale",
      [
        `--socket=${SOCKET}`,
        "up",
        `--authkey=${authKey}`,
        `--hostname=${SERVER_HOSTNAME}`,
        `--advertise-tags=${config.tailscale.serverTag}`,
        "--accept-dns=false",
        "--timeout=60s",
      ],
      { timeout: 90_000 }
    );

    socksAgent = new SocksProxyAgent(`socks5://${SOCKS_ADDR}`);
    console.log(`[tailscale] server joined tailnet as ${SERVER_HOSTNAME}`);
  } catch (error) {
    console.warn(
      `[tailscale] server could not join the tailnet (proxy keeps using host addresses). ` +
        `Ensure ${config.tailscale.serverTag} is in tagOwners: ${error instanceof Error ? error.message : error}`
    );
  }
}

// ─── Upstream selection ───────────────────────────────────────────────────────

const REACH_TTL_MS = 20_000;
const reachCache = new Map<string, { ok: boolean; ts: number }>();

function canConnect(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  const key = `${host}:${port}`;
  const cached = reachCache.get(key);
  if (cached && Date.now() - cached.ts < REACH_TTL_MS) return Promise.resolve(cached.ok);

  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    const done = (ok: boolean) => {
      socket.destroy();
      reachCache.set(key, { ok, ts: Date.now() });
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export interface Upstream {
  target: string;
  agent?: SocksProxyAgent;
}

/**
 * Decide where to forward an already-authorized proxy request. Prefers the direct host
 * address (faster, no tailnet dependency); falls back to the agent's tailnet node when the
 * host address cannot be reached from the server.
 */
export async function selectUpstream(
  agentId: string,
  surface: AgentAccessSurface,
  hostTargetUrl: string
): Promise<Upstream> {
  const direct: Upstream = { target: hostTargetUrl };
  if (!socksAgent) return direct;

  try {
    const url = new URL(hostTargetUrl);
    if (await canConnect(url.hostname, Number(url.port || 80))) return direct;

    const [device, state] = await Promise.all([findAgentDevice(agentId), loadAgentState(agentId)]);
    const ip = device?.addresses.find((addr) => !addr.includes(":"));
    const port =
      surface === "terminal"
        ? Number(state.config.env["DEVLET_TERMINAL_PORT"])
        : FIXED_SURFACE_PORTS[surface];
    if (!ip || !port) return direct;

    return { target: `http://${ip}:${port}`, agent: socksAgent };
  } catch {
    return direct;
  }
}
