function parseCsvSet(value: string): string[] {
  return [
    ...new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
    ),
  ];
}

function parseMultilineEntries(value: string): string[] {
  return value
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const config = {
  publicBaseUrl: (process.env["DEVLET_PUBLIC_BASE_URL"] || "http://localhost:3000").replace(/\/+$/, ""),
  dockerProxyHost: process.env["DEVLET_DOCKER_PROXY_HOST"] || "host.docker.internal",
  agentSsh: {
    authorizedKeys: parseMultilineEntries(process.env["DEVLET_AGENT_SSH_AUTHORIZED_KEYS"] ?? ""),
  },
  portainer: {
    url: process.env["PORTAINER_URL"] ?? "",
    apiKey: process.env["PORTAINER_API_KEY"] ?? "",
    excludedEndpoints: parseCsvSet(process.env["PORTAINER_EXCLUDED_ENDPOINTS"] ?? ""),
  },
  proxmox: {
    url: process.env["PROXMOX_URL"] ?? "",
    user: process.env["PROXMOX_USER"] ?? "",
    tokenId: process.env["PROXMOX_TOKEN_ID"] ?? "",
    tokenSecret: process.env["PROXMOX_TOKEN_SECRET"] ?? "",
    insecure: process.env["PROXMOX_INSECURE"] === "true",
    excludedNodes: parseCsvSet(process.env["PROXMOX_EXCLUDED_NODES"] ?? ""),
  },
  tailscale: {
    clientId: process.env["TAILSCALE_OAUTH_CLIENT_ID"] ?? "",
    clientSecret: process.env["TAILSCALE_OAUTH_CLIENT_SECRET"] ?? "",
    // "-" means the default tailnet of the OAuth client.
    tailnet: process.env["TAILSCALE_TAILNET"] || "-",
    tag: process.env["TAILSCALE_AGENT_TAG"] || "tag:devlet-agent",
    // The Devlet server itself joins the tailnet so it can proxy agents whose host
    // address is unreachable. Needs this tag in tagOwners + a grant to the agent tag.
    serverTag: process.env["TAILSCALE_SERVER_TAG"] || "tag:devlet-server",
    // Tailscale only mints a key if the request names ALL tags of the OAuth client, so the
    // server node needs its own client (tagged only with serverTag), separate from agents'.
    serverClientId: process.env["TAILSCALE_SERVER_OAUTH_CLIENT_ID"] ?? "",
    serverClientSecret: process.env["TAILSCALE_SERVER_OAUTH_CLIENT_SECRET"] ?? "",
    serverEnabled: process.env["TAILSCALE_SERVER_ENABLED"] !== "false",
    // Opt-out: agents join the tailnet unless hired with DEVLET_TAILSCALE=false.
    // Set TAILSCALE_DEFAULT_ENABLED=false to flip this to opt-in.
    defaultEnabled: process.env["TAILSCALE_DEFAULT_ENABLED"] !== "false",
  },
  komodo: {
    url: process.env["KOMODO_URL"] ?? "",
    apiKey: process.env["KOMODO_API_KEY"] ?? "",
    apiSecret: process.env["KOMODO_API_SECRET"] ?? "",
    excludedServers: parseCsvSet(process.env["KOMODO_EXCLUDED_SERVERS"] ?? ""),
    // "name=host,id=host" — address Devlet should use to reach each Komodo server's
    // published agent ports. Komodo often has no reachable address for servers that
    // connect to the core outbound (and public_ip is just their shared WAN IP).
    serverHosts: Object.fromEntries(
      parseCsvSet(process.env["KOMODO_SERVER_HOSTS"] ?? "")
        .map((entry) => entry.split("=").map((part) => part.trim()))
        .filter((pair): pair is [string, string] => pair.length === 2 && Boolean(pair[0]) && Boolean(pair[1]))
    ) as Record<string, string>,
  },
} as const;
