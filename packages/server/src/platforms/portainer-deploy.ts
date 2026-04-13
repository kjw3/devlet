import type { AgentConfig } from "@devlet/shared";
import { config as appConfig } from "../config.js";
import { AGENT_IMAGE, parseDockerLogBuffer } from "./docker.js";
import { buildContainerEnv } from "./env.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function headers() {
  return {
    "X-API-Key": appConfig.portainer.apiKey,
    "Content-Type": "application/json",
  };
}

function proxyUrl(endpointId: number, path: string) {
  return `${appConfig.portainer.url}/api/endpoints/${endpointId}/docker${path}`;
}

/** Pull image via Portainer's Docker proxy — consumes the streaming progress response. */
async function pullImage(endpointId: number, image: string): Promise<void> {
  const res = await fetch(
    `${appConfig.portainer.url}/api/endpoints/${endpointId}/docker/images/create?fromImage=${encodeURIComponent(image)}`,
    { method: "POST", headers: headers() }
  );
  if (!res.ok) {
    throw new Error(`Portainer image pull (endpoint ${endpointId}) failed: HTTP ${res.status}`);
  }
  await res.text(); // consume stream to wait for completion
}

// ─── Exported deploy operations ───────────────────────────────────────────────

/**
 * Create and start an agent container on a Portainer-managed endpoint.
 * Returns a platformRef in the format `portainer:{endpointId}:{containerId}`.
 */
export async function createPortainerContainer(
  agentConfig: AgentConfig,
  endpointId: number
): Promise<string> {
  const image = AGENT_IMAGE[agentConfig.type];

  await pullImage(endpointId, image);

  const ExposedPorts: Record<string, Record<string, never>> = {};
  const PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};

  const terminalPort = agentConfig.env["DEVLET_TERMINAL_PORT"];
  if (terminalPort) {
    ExposedPorts[`${terminalPort}/tcp`] = {};
    PortBindings[`${terminalPort}/tcp`] = [{ HostIp: "0.0.0.0", HostPort: terminalPort }];
  }

  if (agentConfig.type === "openclaw") {
    const hostPort = agentConfig.env["OPENCLAW_HOST_PORT"] ?? "18789";
    ExposedPorts["18789/tcp"] = {};
    PortBindings["18789/tcp"] = [{ HostIp: "0.0.0.0", HostPort: hostPort }];
  }

  if (agentConfig.type === "moltis") {
    const hostPort = agentConfig.env["MOLTIS_HOST_PORT"] ?? "13131";
    ExposedPorts["13131/tcp"] = {};
    PortBindings["13131/tcp"] = [{ HostIp: "0.0.0.0", HostPort: hostPort }];
  }

  const createRes = await fetch(
    `${proxyUrl(endpointId, "/containers/create")}?name=devlet-${agentConfig.id}`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        Image: image,
        Env: await buildContainerEnv(agentConfig),
        ExposedPorts,
        Labels: {
          "devlet.agent.id": agentConfig.id,
          "devlet.agent.type": agentConfig.type,
          "devlet.agent.name": agentConfig.name,
          "devlet.managed": "true",
        },
        HostConfig: {
          NanoCpus: Math.round(agentConfig.resources.cpus * 1e9),
          Memory: agentConfig.resources.memoryMb * 1024 * 1024,
          PortBindings,
        },
      }),
    }
  );

  if (!createRes.ok) {
    const detail = await createRes.text();
    throw new Error(
      `Portainer container create (endpoint ${endpointId}) failed: HTTP ${createRes.status} — ${detail}`
    );
  }

  const { Id: containerId } = (await createRes.json()) as { Id: string };

  const startRes = await fetch(
    proxyUrl(endpointId, `/containers/${containerId}/start`),
    { method: "POST", headers: headers() }
  );

  // 304 = already started, which is fine
  if (!startRes.ok && startRes.status !== 304) {
    throw new Error(
      `Portainer container start (endpoint ${endpointId}) failed: HTTP ${startRes.status}`
    );
  }

  return `portainer:${endpointId}:${containerId}`;
}

export async function stopPortainerContainer(
  endpointId: number,
  containerId: string
): Promise<void> {
  const res = await fetch(
    `${proxyUrl(endpointId, `/containers/${containerId}/stop`)}?t=5`,
    { method: "POST", headers: headers() }
  );
  // 304 = already stopped
  if (!res.ok && res.status !== 304 && res.status !== 404) {
    throw new Error(`Portainer container stop failed: HTTP ${res.status}`);
  }
}

export async function removePortainerContainer(
  endpointId: number,
  containerId: string
): Promise<void> {
  const res = await fetch(
    `${proxyUrl(endpointId, `/containers/${containerId}`)}?force=true&v=true`,
    { method: "DELETE", headers: headers() }
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`Portainer container remove failed: HTTP ${res.status}`);
  }
}

export async function getPortainerContainerRunning(
  endpointId: number,
  containerId: string
): Promise<boolean | null> {
  const res = await fetch(
    proxyUrl(endpointId, `/containers/${containerId}/json`),
    { headers: headers() }
  );
  if (!res.ok) return null; // container not found or endpoint unreachable
  const data = await res.json() as { State?: { Running?: boolean } };
  return data.State?.Running ?? false;
}

export async function getPortainerContainerLogs(
  endpointId: number,
  containerId: string
): Promise<string[]> {
  const res = await fetch(
    `${proxyUrl(endpointId, `/containers/${containerId}/logs`)}?stdout=1&stderr=1&tail=100`,
    { headers: headers() }
  );
  if (!res.ok) {
    throw new Error(`Portainer container logs failed: HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return parseDockerLogBuffer(buffer);
}
