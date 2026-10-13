import { trpc } from "../client.js";

export type ExcludablePlatform = "portainer" | "proxmox" | "komodo";

function printDocker() {
  return trpc.platforms.docker.status.query().then((status) => {
    console.log("\nDocker");
    console.log("─".repeat(48));
    if (!status.connected) {
      console.log(status.error ?? "disconnected");
      return;
    }
    const arch = status.architecture && status.architecture !== "unknown"
      ? ` [${status.architecture}]`
      : "";
    console.log(`local${arch}`);
  });
}

function printPortainer() {
  return trpc.platforms.portainer.status.query().then((status) => {
    console.log("\nPortainer");
    console.log("─".repeat(48));
    if (!status.connected) {
      console.log(status.error ?? "disconnected");
      return;
    }
    for (const endpoint of [...status.endpoints].sort((a, b) => a.name.localeCompare(b.name))) {
      const suffix = endpoint.excluded ? " [excluded]" : "";
      const arch = endpoint.architecture && endpoint.architecture !== "unknown"
        ? ` [${endpoint.architecture}]`
        : "";
      console.log(`${String(endpoint.id).padEnd(6)} ${endpoint.name}${arch}${suffix}`);
    }
  });
}

function printProxmox() {
  return trpc.platforms.proxmox.status.query().then((status) => {
    console.log("\nProxmox");
    console.log("─".repeat(48));
    if (!status.connected) {
      console.log(status.error ?? "disconnected");
      return;
    }
    for (const node of [...status.nodes].sort((a, b) => a.name.localeCompare(b.name))) {
      const suffix = node.excluded ? " [excluded]" : "";
      const arch = node.architecture && node.architecture !== "unknown"
        ? ` [${node.architecture}]`
        : "";
      console.log(`${node.name}${arch}${suffix}`);
    }
  });
}

function printKomodo() {
  return trpc.platforms.komodo.status.query().then((status) => {
    console.log("\nKomodo");
    console.log("─".repeat(48));
    if (!status.connected) {
      console.log(status.error ?? "disconnected");
      return;
    }
    for (const server of [...status.servers].sort((a, b) => a.name.localeCompare(b.name))) {
      const suffix = server.excluded ? " [excluded]" : "";
      const arch = server.architecture && server.architecture !== "unknown"
        ? ` [${server.architecture}]`
        : "";
      const gpu = server.gpuAvailable ? " [gpu]" : "";
      console.log(`${server.name}${arch}${gpu}${suffix}`);
    }
  });
}

export async function platformsStatusCommand() {
  try {
    await printDocker();
    await printPortainer();
    await printProxmox();
    await printKomodo();
    console.log();
  } catch {
    console.error("error: cannot connect to devlet server (is it running, and is DEVLET_AUTH_TOKEN set?)");
    process.exit(1);
  }
}

export async function platformsSetExcludedCommand(
  platform: ExcludablePlatform,
  target: string,
  excluded: boolean
) {
  try {
    if (platform === "portainer") {
      await trpc.platforms.portainer.setExcluded.mutate({ target, excluded });
    } else if (platform === "proxmox") {
      await trpc.platforms.proxmox.setExcluded.mutate({ target, excluded });
    } else {
      await trpc.platforms.komodo.setExcluded.mutate({ target, excluded });
    }
  } catch {
    console.error("error: failed to update platform exclusion (is DEVLET_AUTH_TOKEN set?)");
    process.exit(1);
  }

  const action = excluded ? "excluded" : "included";
  console.log(`${platform} target "${target}" ${action} for scheduling`);
}
