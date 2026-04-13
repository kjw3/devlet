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
