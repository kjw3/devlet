export const config = {
  portainer: {
    url: process.env["PORTAINER_URL"] ?? "",
    apiKey: process.env["PORTAINER_API_KEY"] ?? "",
  },
  proxmox: {
    url: process.env["PROXMOX_URL"] ?? "",
    user: process.env["PROXMOX_USER"] ?? "",
    tokenId: process.env["PROXMOX_TOKEN_ID"] ?? "",
    tokenSecret: process.env["PROXMOX_TOKEN_SECRET"] ?? "",
    insecure: process.env["PROXMOX_INSECURE"] === "true",
  },
} as const;
