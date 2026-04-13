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

export const config = {
  publicBaseUrl: (process.env["DEVLET_PUBLIC_BASE_URL"] ?? "http://localhost:3000").replace(/\/+$/, ""),
  dockerProxyHost: process.env["DEVLET_DOCKER_PROXY_HOST"] ?? "host.docker.internal",
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
} as const;
