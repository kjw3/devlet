import http from "node:http";
import https from "node:https";
import type { ProxmoxStatus } from "@devlet/shared";
import { config } from "../config.js";

interface ProxmoxApiVersion {
  version: string;
}

interface ProxmoxApiNode {
  node: string;
  status: string;
  cpu: number;
  mem: number;
  maxmem: number;
}

function fetchJson<T>(url: string, headers: Record<string, string>, insecure: boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https:") ? https : http;
    const req = transport.request(
      url,
      {
        method: "GET",
        headers,
        ...(url.startsWith("https:")
          ? { rejectUnauthorized: !insecure }
          : {}),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`${url} HTTP ${res.statusCode ?? 500}`));
            return;
          }

          try {
            resolve(JSON.parse(body) as T);
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

export async function probeProxmox(): Promise<ProxmoxStatus> {
  const { url, user, tokenId, tokenSecret, insecure } = config.proxmox;

  if (!url || !user || !tokenId || !tokenSecret) {
    return {
      connected: false,
      nodes: [],
      error: "Proxmox credentials not configured (PROXMOX_URL, PROXMOX_USER, PROXMOX_TOKEN_ID, PROXMOX_TOKEN_SECRET)",
    };
  }

  // PVE API token auth header format: PVEAPIToken=user@realm!tokenid=secret
  // PROXMOX_USER may already include !tokenid (e.g. "aiagent@pam!aiagent"),
  // in which case we use it as-is rather than appending PROXMOX_TOKEN_ID again.
  const tokenIdentifier = user.includes("!") ? user : `${user}!${tokenId}`;
  const authHeader = `PVEAPIToken=${tokenIdentifier}=${tokenSecret}`;
  const headers = { Authorization: authHeader };

  try {
    const [versionData, nodesData] = await Promise.all([
      fetchJson<{ data: ProxmoxApiVersion }>(`${url}/api2/json/version`, headers, insecure),
      fetchJson<{ data: ProxmoxApiNode[] }>(`${url}/api2/json/nodes`, headers, insecure),
    ]);

    return {
      connected: true,
      version: versionData.data.version,
      nodes: nodesData.data.map((n) => ({
        name: n.node,
        status: n.status === "online" ? "online" : n.status === "offline" ? "offline" : "unknown",
        cpuUsage: n.cpu,
        memoryUsed: Math.round(n.mem / 1024 / 1024),
        memoryTotal: Math.round(n.maxmem / 1024 / 1024),
      })),
    };
  } catch (err) {
    return {
      connected: false,
      nodes: [],
      error: String(err),
    };
  }
}
