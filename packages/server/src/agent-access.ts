import { createHmac, timingSafeEqual } from "crypto";
import type { AgentState, PlatformTarget } from "@devlet/shared";
import { config } from "./config.js";
import { probePortainer } from "./platforms/portainer.js";

export type AgentAccessSurface = "terminal" | "openclaw" | "moltis";

function getProxySecret(): string {
  const secret = process.env["DEVLET_AUTH_TOKEN"];
  if (!secret) {
    throw new Error("DEVLET_AUTH_TOKEN must be set");
  }
  return secret;
}

function hmac(value: string): string {
  return createHmac("sha256", getProxySecret()).update(value).digest("hex");
}

export async function getPortainerEndpointHost(endpointId: number): Promise<string> {
  try {
    const status = await probePortainer();
    const endpoint = status.endpoints.find((item) => item.id === endpointId);
    if (!endpoint) return "localhost";

    if (endpoint.url.startsWith("unix://")) {
      return "localhost";
    }

    const normalized = endpoint.url.includes("://")
      ? endpoint.url
      : `tcp://${endpoint.url}`;
    return new URL(normalized).hostname || "localhost";
  } catch {
    return "localhost";
  }
}

export async function resolveAgentAccessHost(platform: PlatformTarget): Promise<string> {
  if (platform.type === "portainer") {
    return getPortainerEndpointHost(platform.endpointId);
  }
  return "localhost";
}

async function resolveAgentProxyTargetHost(platform: PlatformTarget): Promise<string> {
  if (platform.type === "portainer") {
    return getPortainerEndpointHost(platform.endpointId);
  }
  if (platform.type === "docker") {
    return config.dockerProxyHost;
  }
  return "localhost";
}

export async function resolveSurfaceTargetUrl(
  state: AgentState,
  surface: AgentAccessSurface
): Promise<string | null> {
  const host = await resolveAgentProxyTargetHost(state.config.platform);

  switch (surface) {
    case "terminal": {
      const port = state.config.env["DEVLET_TERMINAL_PORT"];
      return port ? `http://${host}:${port}` : null;
    }
    case "openclaw": {
      if (state.config.type !== "openclaw") return null;
      const port = state.config.env["OPENCLAW_HOST_PORT"];
      return port ? `http://${host}:${port}` : null;
    }
    case "moltis": {
      if (state.config.type !== "moltis") return null;
      const port = state.config.env["MOLTIS_HOST_PORT"];
      return port ? `http://${host}:${port}` : null;
    }
  }
}

function buildProxySignaturePayload(
  agentId: string,
  surface: AgentAccessSurface,
  targetUrl: string
): string {
  return `v1:${agentId}:${surface}:${targetUrl}`;
}

export function buildAgentProxyToken(
  agentId: string,
  surface: AgentAccessSurface,
  targetUrl: string
): string {
  return hmac(buildProxySignaturePayload(agentId, surface, targetUrl));
}

export function validateAgentProxyToken(
  agentId: string,
  surface: AgentAccessSurface,
  targetUrl: string,
  provided: string | null | undefined
): boolean {
  if (!provided) return false;

  const expected = Buffer.from(buildAgentProxyToken(agentId, surface, targetUrl));
  const received = Buffer.from(provided);

  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function buildAgentProxyUrl(
  agentId: string,
  surface: AgentAccessSurface,
  targetUrl: string,
  extraQuery?: Record<string, string | undefined>
): string {
  const proxyToken = buildAgentProxyToken(agentId, surface, targetUrl);
  const url = new URL(`${config.publicBaseUrl}/agent-access/${agentId}/${surface}/${proxyToken}/`);

  for (const [key, value] of Object.entries(extraQuery ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  return url.toString();
}
