import Docker from "dockerode";
import net from "net";
import type { AgentConfig, AgentType, DockerImage, DockerStatus } from "@devlet/shared";
import { buildContainerEnv } from "./env.js";

function normalizeArchitecture(value: string | undefined): "amd64" | "arm64" | "unknown" {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "amd64" || normalized === "x86_64") return "amd64";
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  return "unknown";
}

// Agent images — configurable via env vars.
export const AGENT_IMAGE: Record<AgentType, string> = {
  // Base image handles claude-code, codex, opencode, pi, gemini via DEVLET_AGENT_TYPE dispatch
  "claude-code": process.env["AGENT_IMAGE_CLAUDE_CODE"] ?? "devlet/agent-base:latest",
  "codex":       process.env["AGENT_IMAGE_CODEX"]       ?? "devlet/agent-base:latest",
  "opencode":    process.env["AGENT_IMAGE_OPENCODE"]    ?? "devlet/agent-base:latest",
  "pi":          process.env["AGENT_IMAGE_PI"]          ?? "devlet/agent-base:latest",
  "gemini":      process.env["AGENT_IMAGE_GEMINI"]      ?? "devlet/agent-base:latest",
  // Specialised images
  "openclaw":    process.env["AGENT_IMAGE_OPENCLAW"]    ?? "devlet/agent-openclaw:latest",
  "nanoclaw":    process.env["AGENT_IMAGE_NANOCLAW"]    ?? "devlet/agent-nanoclaw:latest",
  "hermes":      process.env["AGENT_IMAGE_HERMES"]      ?? "devlet/agent-hermes:latest",
  "moltis":      process.env["AGENT_IMAGE_MOLTIS"]      ?? "devlet/agent-moltis:latest",
  // Proxmox-only — placeholder until Proxmox provisioning is implemented
  "nemoclaw":    process.env["AGENT_IMAGE_NEMOCLAW"]    ?? "node:22.22.2-slim",
};

/** Probe a TCP port on 0.0.0.0 to see if it is available on the host. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });
}

/**
 * Find the first free TCP port in [7681, 8681] on the host.
 * Used to allocate a unique host-side port for the ttyd web terminal.
 */
export async function allocateFreeTerminalPort(): Promise<number> {
  const start = 7681;
  const end   = 8681;
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port available in range ${start}–${end}`);
}

/**
 * Find the first free TCP port in [18789, 19789] on the host.
 * Used to allocate a unique host-side port for the OpenClaw Control UI.
 */
export async function allocateFreeOpenClawPort(): Promise<number> {
  const start = 18789;
  const end   = 19789;
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port available in range ${start}–${end}`);
}

/**
 * Find the first free TCP port in [13131, 14131] on the host.
 * Used to allocate a unique host-side port for the Moltis gateway UI.
 */
export async function allocateFreeMoltisPort(): Promise<number> {
  const start = 13131;
  const end   = 14131;
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port available in range ${start}–${end}`);
}

/**
 * Find the first free TCP port in [2222, 3222] on the host.
 * Used to allocate a unique host-side port for direct SSH access.
 */
export async function allocateFreeSshPort(): Promise<number> {
  const start = 2222;
  const end   = 3222;
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port available in range ${start}–${end}`);
}

function createDocker(socketPath?: string): Docker {
  return socketPath ? new Docker({ socketPath }) : new Docker();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseDockerLogBuffer(buffer: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const frameSize = buffer.readUInt32BE(offset + 4);
    const frameStart = offset + 8;
    const frameEnd = frameStart + frameSize;

    if (frameEnd > buffer.length) {
      break;
    }

    const payload = buffer.toString("utf8", frameStart, frameEnd);
    lines.push(...payload.split(/\r?\n/).filter(Boolean));
    offset = frameEnd;
  }

  if (lines.length > 0) {
    return lines.slice(-100);
  }

  return buffer
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-100);
}

export async function probeDocker(): Promise<DockerStatus> {
  try {
    const docker = createDocker();
    await docker.ping();

    const [versionInfo, info, containers] = await Promise.all([
      docker.version(),
      docker.info(),
      docker.listContainers({ all: true }),
    ]);

    const running = containers.filter(
      (container: { State?: string }) => container.State === "running"
    ).length;
    const total = containers.length;
    const stopped = total - running;

    return {
      connected: true,
      version: versionInfo.Version,
      containers: { running, stopped, total },
      gpuAvailable: Boolean(info.Runtimes?.nvidia),
      architecture: normalizeArchitecture(info.Architecture),
    };
  } catch (error) {
    return {
      connected: false,
      containers: { running: 0, stopped: 0, total: 0 },
      error: getErrorMessage(error),
    };
  }
}

export async function listImages(): Promise<DockerImage[]> {
  const docker = createDocker();
  const images = await docker.listImages();

  return images.map((image: {
    Id: string;
    RepoTags?: string[] | null;
    Size: number;
    Created: number;
  }) => ({
    id: image.Id,
    tags: image.RepoTags ?? [],
    sizeBytes: image.Size,
    createdAt: new Date(image.Created * 1000).toISOString(),
  }));
}

async function ensureImage(docker: Docker, image: string): Promise<void> {
  const isDigestPinned = image.includes("@sha256:");
  const lastColon = image.lastIndexOf(":");
  const lastSlash = image.lastIndexOf("/");
  const tag = lastColon > lastSlash ? image.slice(lastColon + 1) : "";
  const shouldRefresh = !isDigestPinned && (tag === "" || tag === "latest");

  if (shouldRefresh) {
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
    return;
  }

  try {
    await docker.getImage(image).inspect();
  } catch {
    // Not available locally — pull from registry
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }
}

export async function createAgentContainer(config: AgentConfig): Promise<string> {
  const docker =
    config.platform.type === "docker"
      ? createDocker(config.platform.socketPath)
      : createDocker();

  const image = AGENT_IMAGE[config.type];
  await ensureImage(docker, image);

  const ExposedPorts: Record<string, Record<string, never>> = {};
  const PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};

  // Web terminal — bound for all agent types when DEVLET_TERMINAL_PORT is set.
  // ttyd inside the container binds to the same port number it receives via env.
  const terminalPort = config.env["DEVLET_TERMINAL_PORT"];
  if (terminalPort) {
    ExposedPorts[`${terminalPort}/tcp`] = {};
    PortBindings[`${terminalPort}/tcp`] = [{ HostIp: "127.0.0.1", HostPort: terminalPort }];
  }

  const sshPort = config.env["DEVLET_SSH_PORT"];
  if (sshPort) {
    ExposedPorts[`${sshPort}/tcp`] = {};
    PortBindings[`${sshPort}/tcp`] = [{ HostIp: "127.0.0.1", HostPort: sshPort }];
  }

  // OpenClaw Control UI (18789)
  if (config.type === "openclaw") {
    const hostPort = config.env["OPENCLAW_HOST_PORT"] ?? "18789";
    ExposedPorts["18789/tcp"] = {};
    PortBindings["18789/tcp"] = [{ HostIp: "127.0.0.1", HostPort: hostPort }];
  }

  // Moltis gateway (13131) — container always binds to 13131; host port is allocated.
  if (config.type === "moltis") {
    const hostPort = config.env["MOLTIS_HOST_PORT"] ?? "13131";
    ExposedPorts["13131/tcp"] = {};
    PortBindings["13131/tcp"] = [{ HostIp: "127.0.0.1", HostPort: hostPort }];
  }

  const container = await docker.createContainer({
    Image: image,
    Env: await buildContainerEnv(config),
    ExposedPorts,
    Labels: {
      "devlet.agent.id": config.id,
      "devlet.agent.type": config.type,
      "devlet.agent.name": config.name,
      "devlet.managed": "true",
    },
    HostConfig: {
      NanoCpus: Math.round(config.resources.cpus * 1e9),
      Memory: config.resources.memoryMb * 1024 * 1024,
      PortBindings,
    },
  });

  await container.start();
  return container.id;
}

export async function stopContainer(containerId: string): Promise<void> {
  const docker = createDocker();

  try {
    await docker.getContainer(containerId).stop();
  } catch (error) {
    const message = getErrorMessage(error).toLowerCase();
    if (
      message.includes("is not running") ||
      message.includes("not modified") ||
      message.includes("already stopped") ||
      message.includes("no such container") ||
      message.includes("not found") ||
      message.includes("304")
    ) {
      return;
    }
    throw error;
  }
}

export async function removeContainer(containerId: string): Promise<void> {
  const docker = createDocker();

  try {
    // v: true removes any anonymous volumes created with the container
    await docker.getContainer(containerId).remove({ force: true, v: true });
  } catch (error) {
    const message = getErrorMessage(error).toLowerCase();
    if (message.includes("no such container") || message.includes("not found")) {
      return;
    }
    throw error;
  }
}

export async function getContainerRunning(containerId: string): Promise<boolean | null> {
  const docker = createDocker();
  try {
    const info = await docker.getContainer(containerId).inspect() as { State?: { Running?: boolean } };
    return info.State?.Running ?? false;
  } catch {
    return null; // container not found
  }
}

export async function getContainerLogs(containerId: string): Promise<string[]> {
  const docker = createDocker();
  // Without {follow: true}, Dockerode returns Buffer (the multiplexed log format)
  const raw = await docker.getContainer(containerId).logs({
    stdout: true,
    stderr: true,
    tail: 100,
  }) as Buffer;

  return parseDockerLogBuffer(raw);
}
