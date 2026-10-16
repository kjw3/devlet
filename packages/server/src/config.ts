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
    // Provisioning (docs/proxmox-provisioning.md):
    node: process.env["PROXMOX_NODE"] ?? "",
    storage: process.env["PROXMOX_STORAGE"] || "local-lvm",
    // LXC OS template volid, e.g. "local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst"
    lxcTemplate: process.env["PROXMOX_LXC_TEMPLATE"] ?? "",
    // QEMU template VM ID to full-clone for VM agents (0 = not configured)
    qemuTemplateId: Number(process.env["PROXMOX_QEMU_TEMPLATE_ID"] ?? 0) || 0,
    // Optional dedicated QEMU template for GPU agents (NVIDIA driver installed
    // inside). Falls back to qemuTemplateId when unset.
    qemuGpuTemplateId: Number(process.env["PROXMOX_QEMU_GPU_TEMPLATE_ID"] ?? 0) || 0,
    // Storage for QEMU clones (overrides). Unset = PROXMOX_STORAGE when cloning
    // on the template's node, else the template's own (shared) disk storage.
    qemuStorage: process.env["PROXMOX_QEMU_STORAGE"] ?? "",
    // Optional: PCI id (e.g. "0000:01:00.0") to set as hostpci0 when the QEMU
    // template does not already carry GPU passthrough config.
    gpuPciId: process.env["PROXMOX_GPU_PCI_ID"] ?? "",
    // Optional root@pam API token — PVE allows only root to set hostpci* (GPU
    // passthrough), even for tokens with full privileges. Used solely for the
    // GPU config step; everything else runs with the regular token.
    rootUser: process.env["PROXMOX_ROOT_USER"] ?? "",
    rootTokenId: process.env["PROXMOX_ROOT_TOKEN_ID"] ?? "",
    rootTokenSecret: process.env["PROXMOX_ROOT_TOKEN_SECRET"] ?? "",
    // Bridge guests attach to (vmbr0 on default installs).
    bridge: process.env["PROXMOX_BRIDGE"] || "vmbr0",
    vlan: process.env["PROXMOX_VLAN"] || "",
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
