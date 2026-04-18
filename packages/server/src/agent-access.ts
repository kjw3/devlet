import { createHmac, timingSafeEqual } from "crypto";
import type { AgentConfig, AgentState, PlatformTarget } from "@devlet/shared";
import { config } from "./config.js";
import { probePortainer } from "./platforms/portainer.js";
import { loadAgentState } from "./agents/state.js";

export type AgentAccessSurface = "terminal" | "openclaw" | "moltis";
const SUBDOMAIN_TOKEN_LENGTH = 24;
const SUBDOMAIN_DELIMITER = "--";

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

function getPublicBaseUrl(): URL {
  return new URL(config.publicBaseUrl);
}

function getPublicBaseHostPattern(): { hostname: string; port: string } {
  const base = getPublicBaseUrl();
  return {
    hostname: base.hostname.toLowerCase(),
    port: base.port,
  };
}

function supportsWildcardSubdomains(): boolean {
  const { hostname } = getPublicBaseHostPattern();
  if (hostname === "localhost") return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  if (hostname.includes(":")) return false;
  return hostname.includes(".");
}

function sanitizeHostnameLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

export async function resolveSurfaceTargetUrl(
  state: AgentState,
  surface: AgentAccessSurface
): Promise<string | null> {
  return resolveSurfaceTargetUrlForConfig(state.config, surface);
}

export async function resolveSurfaceTargetUrlForConfig(
  agentConfig: AgentConfig,
  surface: AgentAccessSurface
): Promise<string | null> {
  const host = await resolveAgentProxyTargetHost(agentConfig.platform);

  switch (surface) {
    case "terminal": {
      const port = agentConfig.env["DEVLET_TERMINAL_PORT"];
      return port ? `http://${host}:${port}` : null;
    }
    case "openclaw": {
      if (agentConfig.type !== "openclaw") return null;
      const port = agentConfig.env["OPENCLAW_HOST_PORT"];
      return port ? `http://${host}:${port}` : null;
    }
    case "moltis": {
      if (agentConfig.type !== "moltis") return null;
      const port = agentConfig.env["MOLTIS_HOST_PORT"];
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

function validateAgentProxyTokenPrefix(
  agentId: string,
  surface: AgentAccessSurface,
  targetUrl: string,
  providedPrefix: string | null | undefined
): boolean {
  if (!providedPrefix) return false;

  const expectedPrefix = buildAgentProxyToken(agentId, surface, targetUrl).slice(0, providedPrefix.length);
  const expected = Buffer.from(expectedPrefix);
  const received = Buffer.from(providedPrefix);

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

export function buildAgentSubdomainUrl(
  agentId: string,
  surface: AgentAccessSurface,
  targetUrl: string,
  extraQuery?: Record<string, string | undefined>
): string | null {
  if (!supportsWildcardSubdomains()) return null;

  const base = getPublicBaseUrl();
  const tokenPrefix = buildAgentProxyToken(agentId, surface, targetUrl).slice(0, SUBDOMAIN_TOKEN_LENGTH);
  const label = [
    sanitizeHostnameLabel(surface),
    sanitizeHostnameLabel(agentId),
    tokenPrefix,
  ].join(SUBDOMAIN_DELIMITER);

  const url = new URL(base.toString());
  url.hostname = `${label}.${base.hostname}`;
  url.port = base.port;
  url.pathname = "/";
  url.search = "";
  url.hash = "";

  for (const [key, value] of Object.entries(extraQuery ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  return url.toString();
}

export async function buildResolvedAgentSubdomainUrl(
  agentConfig: AgentConfig,
  surface: AgentAccessSurface,
  extraQuery?: Record<string, string | undefined>
): Promise<string | null> {
  const targetUrl = await resolveSurfaceTargetUrlForConfig(agentConfig, surface);
  if (!targetUrl) return null;
  return buildAgentSubdomainUrl(agentConfig.id, surface, targetUrl, extraQuery);
}

export async function buildPreferredAgentAccessUrl(
  agentConfig: AgentConfig,
  surface: AgentAccessSurface,
  extraQuery?: Record<string, string | undefined>
): Promise<string | null> {
  const targetUrl = await resolveSurfaceTargetUrlForConfig(agentConfig, surface);
  if (!targetUrl) return null;

  return buildAgentSubdomainUrl(agentConfig.id, surface, targetUrl, extraQuery)
    ?? buildAgentProxyUrl(agentConfig.id, surface, targetUrl, extraQuery);
}

export async function resolveAgentProxyRequestFromHost(
  hostHeader: string | undefined,
  requestUrl: string
): Promise<{
  ok: true;
  agentId: string;
  surface: AgentAccessSurface;
  targetUrl: string;
  rewrittenPath: string;
} | {
  ok: false;
  statusCode: number;
  message: string;
} | null> {
  if (!supportsWildcardSubdomains() || !hostHeader) {
    return null;
  }

  const requestHost = hostHeader.split(":")[0]?.toLowerCase() ?? "";
  const { hostname: baseHostname } = getPublicBaseHostPattern();
  if (!requestHost.endsWith(`.${baseHostname}`)) {
    return null;
  }

  const label = requestHost.slice(0, -(baseHostname.length + 1));
  if (!label || label.includes(".")) {
    return null;
  }

  const parts = label.split(SUBDOMAIN_DELIMITER);
  if (parts.length < 3) {
    return { ok: false, statusCode: 404, message: "Unknown agent access subdomain" };
  }

  const surface = (parts[0] ? parts[0] as AgentAccessSurface : null);
  if (surface !== "terminal" && surface !== "openclaw" && surface !== "moltis") {
    return { ok: false, statusCode: 404, message: "Unknown agent access surface" };
  }

  const tokenPrefix = parts.at(-1) ?? "";
  const agentId = parts.slice(1, -1).join(SUBDOMAIN_DELIMITER);
  if (!agentId || !tokenPrefix) {
    return { ok: false, statusCode: 404, message: "Invalid agent access subdomain" };
  }

  const state = await loadAgentState(agentId).catch(() => null);
  if (!state) {
    return { ok: false, statusCode: 404, message: "Agent not found" };
  }

  const targetUrl = await resolveSurfaceTargetUrl(state, surface);
  if (!targetUrl) {
    return { ok: false, statusCode: 404, message: "Requested surface is not available for this agent" };
  }

  if (!validateAgentProxyTokenPrefix(agentId, surface, targetUrl, tokenPrefix)) {
    return { ok: false, statusCode: 401, message: "Invalid proxy token" };
  }

  const parsed = new URL(requestUrl, "http://localhost:3001");
  const query = parsed.searchParams.toString();

  return {
    ok: true,
    agentId,
    surface,
    targetUrl,
    rewrittenPath: `${parsed.pathname}${query ? `?${query}` : ""}`,
  };
}
