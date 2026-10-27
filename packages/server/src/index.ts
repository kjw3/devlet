import "./platforms/localstorage-shim.js"; // MUST be first — installs localStorage before any komodo_client import is evaluated
import { retainTermination } from "./agents/termination.js";
import { Readable } from "node:stream";
import httpProxy from "http-proxy";
import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./routers/index.js";
import { getAgentRunning, getAgentLogs, getAgentExitDetails, stopAgent, provisionAgent, removeAgent } from "./platforms/dispatch.js";
import {
  listOrphanedKomodoDeployments,
  getOrphanedKomodoDeploymentLog,
  removeOrphanedKomodoDeployment,
} from "./platforms/komodo-deploy.js";
import { probePortainer } from "./platforms/portainer.js";
import { probeKomodo } from "./platforms/komodo.js";
import { probeProxmox } from "./platforms/proxmox.js";
import { listAgentStates, loadAgentState, saveAgentState } from "./agents/state.js";
import {
  validateAgentProxyToken,
  resolveAgentProxyRequestFromHost,
  resolveSurfaceTargetUrl,
  type AgentAccessSurface,
} from "./agent-access.js";
import { config } from "./config.js";
import { selectUpstream, startServerTailnetNode } from "./tailscale/node.js";
import { recoverInterruptedProvisions } from "./agents/provision-recovery.js";
import { reconcilePersistentAgent } from "./agents/runtime-reconcile.js";
import { recordAgentEvent, type AgentEventType } from "./agents/agent-events.js";
import { bootstrapSshKeysFromEnv } from "./ssh/keyStore.js";

const server = Fastify();
const authToken = process.env["DEVLET_AUTH_TOKEN"];
const agentUiProxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: false,
  ws: true,
  xfwd: true,
});

if (!authToken) {
  throw new Error("DEVLET_AUTH_TOKEN must be set before starting the server");
}

await server.register(cors, {
  origin: new URL(config.publicBaseUrl).origin,
});

type ProxyResolution =
  | { ok: true; agentId: string; surface: AgentAccessSurface; targetUrl: string; rewrittenPath: string }
  | { ok: false; statusCode: number; message: string };

function toWebSocketTarget(targetUrl: string): string {
  const target = new URL(targetUrl);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}

function parseSurface(value: string): AgentAccessSurface | null {
  return value === "terminal" || value === "openclaw" || value === "moltis" ? value : null;
}

async function resolveAgentProxyRequest(requestUrl: string): Promise<ProxyResolution> {
  const parsed = new URL(requestUrl, "http://localhost:3001");
  const parts = parsed.pathname.split("/").filter(Boolean);

  if (parts[0] !== "agent-access" || parts.length < 4) {
    return { ok: false, statusCode: 404, message: "Not found" };
  }

  const agentId = parts[1] ?? "";
  const surface = parseSurface(parts[2] ?? "");
  const proxyToken = parts[3] ?? "";
  if (!surface) {
    return { ok: false, statusCode: 404, message: "Unknown agent access surface" };
  }

  const state = await loadAgentState(agentId).catch(() => null);
  if (!state) {
    return { ok: false, statusCode: 404, message: "Agent not found" };
  }

  const targetUrl = await resolveSurfaceTargetUrl(state, surface);
  if (!targetUrl) {
    return { ok: false, statusCode: 404, message: "Requested surface is not available for this agent" };
  }

  if (!validateAgentProxyToken(agentId, surface, targetUrl, proxyToken)) {
    return { ok: false, statusCode: 401, message: "Invalid proxy token" };
  }

  if (state.status === "terminated") {
    return { ok: false, statusCode: 410, message: "Agent has stopped. SSH and terminal are only available while it is running." };
  }

  const suffix = parts.slice(4).join("/");
  const pathname = suffix ? `/${suffix}` : "/";
  const query = parsed.searchParams.toString();

  return {
    ok: true,
    agentId,
    surface,
    targetUrl,
    rewrittenPath: `${pathname}${query ? `?${query}` : ""}`,
  };
}

agentUiProxy.on("error", (_error, _req, res) => {
  if (!res || "headersSent" in res && res.headersSent) {
    return;
  }
  if ("writeHead" in res) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("Agent UI proxy error");
  }
});

server.addHook("onRequest", async (request, reply) => {
  const resolution = await resolveAgentProxyRequestFromHost(request.headers.host, request.url);
  if (!resolution) {
    return;
  }

  if (!resolution.ok) {
    reply.code(resolution.statusCode);
    await reply.send(resolution.message);
    return reply;
  }

  request.raw.url = resolution.rewrittenPath;
  reply.hijack();
  agentUiProxy.web(request.raw, reply.raw, await selectUpstream(resolution.agentId, resolution.surface, resolution.targetUrl));
  return reply;
});

// Unauthenticated liveness probe for Docker/load balancers; exposes no state.
server.get("/health", async () => ({ status: "ok" }));

// Mission lifecycle events from agent containers (scoped HMAC token, not the
// full DEVLET_AUTH_TOKEN). Body carries no mission content.
const AGENT_EVENT_TYPES: readonly AgentEventType[] = [
  "mission_started",
  "mission_completed",
  "mission_failed",
];
server.post("/api/agent-event", async (request: FastifyRequest, reply: FastifyReply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const event = body["event"] as AgentEventType | undefined;
  if (!event || !AGENT_EVENT_TYPES.includes(event)) {
    reply.code(400);
    return reply.send({ ok: false, message: "unknown event type" });
  }

  const result = await recordAgentEvent({
    agentId: String(body["agentId"] ?? ""),
    token: String(body["token"] ?? ""),
    event,
    at: typeof body["at"] === "string" ? body["at"] : undefined,
  });

  if (!result.ok) {
    reply.code(result.statusCode);
    return reply.send({ ok: false, message: result.message });
  }
  return reply.send({ ok: true });
});

server.all("/trpc/*", async (request: FastifyRequest, reply: FastifyReply) => {
  // Fastify's JSON parser has already consumed the raw stream for
  // application/json bodies, so request.body holds the parsed value. A
  // top-level JSON string (e.g. `"agent-84wq"` for agents.fire) arrives here
  // as a bare JS string — re-serializing with JSON.stringify restores the
  // quotes tRPC needs. Without this, tRPC double-parses the bare string and
  // fails with "Unexpected token". Non-JSON bodies (raw strings/buffers) pass
  // through untouched; streams (no parser registered) pass through as-is.
  const isJsonContentType = String(request.headers["content-type"] ?? "").includes(
    "application/json"
  );
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : isJsonContentType
      ? JSON.stringify(request.body)
      : typeof request.body === "string" || Buffer.isBuffer(request.body)
      ? request.body
      : request.body == null
      ? Readable.toWeb(request.raw)
      : JSON.stringify(request.body);

  const headerEntries: string[][] = [];
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }

    headerEntries.push([key, Array.isArray(value) ? value.join(",") : value]);
  }

  const requestInit: RequestInit =
    body === undefined
      ? {
          method: request.method,
          headers: new Headers(headerEntries),
        }
      : {
          method: request.method,
          headers: new Headers(headerEntries),
          body,
          duplex: "half",
        };

  const trpcRequest = new Request(
    new URL(request.url, `http://${request.headers.host ?? "localhost:3001"}`),
    requestInit
  );

  const response = await fetchRequestHandler({
    endpoint: "/trpc",
    req: trpcRequest,
    router: appRouter,
    createContext: () => ({
      authHeader: request.headers.authorization,
    }),
  });

  reply.status(response.status);
  response.headers.forEach((value, key) => {
    reply.header(key, value);
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  return reply.send(buffer);
});

server.all("/agent-access/:agentId/:surface/:proxyToken", async (request: FastifyRequest, reply: FastifyReply) => {
  const resolution = await resolveAgentProxyRequest(request.url);
  if (!resolution.ok) {
    reply.code(resolution.statusCode);
    return reply.send(resolution.message);
  }

  request.raw.url = resolution.rewrittenPath;
  reply.hijack();
  agentUiProxy.web(request.raw, reply.raw, await selectUpstream(resolution.agentId, resolution.surface, resolution.targetUrl));
});

server.all("/agent-access/:agentId/:surface/:proxyToken/*", async (request: FastifyRequest, reply: FastifyReply) => {
  const resolution = await resolveAgentProxyRequest(request.url);
  if (!resolution.ok) {
    reply.code(resolution.statusCode);
    return reply.send(resolution.message);
  }

  request.raw.url = resolution.rewrittenPath;
  reply.hijack();
  agentUiProxy.web(request.raw, reply.raw, await selectUpstream(resolution.agentId, resolution.surface, resolution.targetUrl));
});

server.server.on("upgrade", async (request, socket, head) => {
  const hostResolution = await resolveAgentProxyRequestFromHost(request.headers.host, request.url ?? "/");
  if (hostResolution) {
    if (!hostResolution.ok) {
      socket.write(`HTTP/1.1 ${hostResolution.statusCode} ${hostResolution.message}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    request.url = hostResolution.rewrittenPath;
    const upstream = await selectUpstream(hostResolution.agentId, hostResolution.surface, hostResolution.targetUrl);
    agentUiProxy.ws(request, socket, head, { ...upstream, target: toWebSocketTarget(upstream.target) });
    return;
  }

  const resolution = await resolveAgentProxyRequest(request.url ?? "/");
  if (!resolution.ok) {
    socket.write(`HTTP/1.1 ${resolution.statusCode} ${resolution.message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  request.url = resolution.rewrittenPath;
  const upstream = await selectUpstream(resolution.agentId, resolution.surface, resolution.targetUrl);
  agentUiProxy.ws(request, socket, head, { ...upstream, target: toWebSocketTarget(upstream.target) });
});

// Capture before accepting hires so recovery cannot overlap a new hire job.
const interruptedProvisions = await listAgentStates();

await server.listen({
  port: 3001,
  host: "0.0.0.0",
});

console.log("Devlet server listening on http://localhost:3001");

await bootstrapSshKeysFromEnv();
void recoverInterruptedProvisions(interruptedProvisions);

// Join the tailnet in the background so the agent-access proxy can fall back to it.
void startServerTailnetNode();

// ─── Background: sync agent status when containers exit ───────────────────────
let syncingAgentStatuses = false;
async function syncAgentStatuses(): Promise<void> {
  if (syncingAgentStatuses) return;
  syncingAgentStatuses = true;
  try {
    const states = await listAgentStates();
    const [portainerStatus, komodoStatus] = await Promise.all([
      probePortainer().catch(() => null),
      probeKomodo().catch(() => null),
    ]);
    await Promise.all(
      states
        .filter((s) => s.status === "running" || s.status === "idle" || (s.status === "error" && s.config.persistent))
        .map(async (state) => {
          try {
            const running = await getAgentRunning(state.platformRef);

            // Persistent agents self-heal: running again → clear a stale
            // error; stopped or missing → reprovision in place (see
            // runtime-reconcile.ts).
            if (state.config.persistent && running !== null) {
              await reconcilePersistentAgent(state, running, {
                provision: () => provisionAgent(state.config),
                save: (s) => saveAgentState(s),
              });
              return;
            }

            if (running === false) {

              await retainTermination(state, {
                logs: () => getAgentLogs(state.platformRef, [], true),
                details: () => getAgentExitDetails(state.platformRef),
                save: saveAgentState,
                cleanup: () => state.config.platform.type === "proxmox"
                  ? stopAgent(state.platformRef) : removeAgent(state.platformRef),
              });
              return;
            }

            if (running === null && state.config.platform.type === "portainer") {
              const platform = state.config.platform;
              const endpoint = portainerStatus?.connected
                ? portainerStatus.endpoints.find((item) => item.id === platform.endpointId)
                : null;

              if (!portainerStatus?.connected || !endpoint || endpoint.status !== 1) {
                state.status = "error";
                state.error = `Portainer endpoint ${platform.endpointId} is offline or unreachable`;
                state.logs.push("[devlet] Portainer endpoint offline — marked error");
                await saveAgentState(state);
              }
            }

            if (running === null && state.config.platform.type === "proxmox") {
              // Proxmox API unreachable — cannot tell guest state; flag it rather
              // than silently assuming the agent is fine (R4).
              const status = await probeProxmox().catch(() => null);
              if (!status?.connected) {
                state.status = "error";
                state.error = "Proxmox API is offline or unreachable";
                state.logs.push("[devlet] Proxmox API unreachable — marked error");
                await saveAgentState(state);
              }
            }

            if (running === null && state.config.platform.type === "komodo") {
              const platform = state.config.platform;
              const server = komodoStatus?.connected
                ? komodoStatus.servers.find(
                    (item) => item.id === platform.serverId || item.name === platform.serverName
                  )
                : null;

              if (!komodoStatus?.connected || !server || server.state !== "ok") {
                state.status = "error";
                state.error = `Komodo server ${platform.serverId} is offline or unreachable`;
                state.logs.push("[devlet] Komodo server offline — marked error");
                await saveAgentState(state);
              }
            }
          } catch {
            // ignore transient errors — don't update state on polling failure
          }
        })
    );
  } catch {
    // don't crash the server on state read errors
  } finally {
    syncingAgentStatuses = false;
  }
}

// Run once at startup too — otherwise a node that died while the server was
// down only gets reconciled up to 15s after boot.
void syncAgentStatuses();
setInterval(syncAgentStatuses, 15_000);

// ─── Background: reconcile orphaned Komodo deployments ───────────────────────
// Tears down `devlet-agent-*` deployments that no agent state references — the
// leak that leaves self-restarting containers behind when a terminate/fire/restart
// cleanup doesn't run to completion, or when the creating server lost its state.
//
// SAFETY: this is OFF by default and gated behind DEVLET_RECONCILE_KOMODO_ORPHANS=1.
// Multiple Devlet servers can share one Komodo instance (e.g. a local dev server
// and a production server). A server must only reconcile against the agents it
// owns; because the orphan scan is scoped to *this* server's state, only the
// server whose state is authoritative for a given deployment should run it. Enable
// it on exactly one server (the one that owns the Komodo agents you want cleaned).
//
// Conservative even when enabled: only touches deployments matching the agent
// naming convention (`devlet-agent-*`) that are absent from every agent's derived
// deployment name and platformRef.
// Runs on a slow interval (well after the 15s status sync) so a freshly-hired
// agent's async provision has long since persisted its platformRef before it could
// be mistaken for an orphan.
const reconcileOrphansEnabled = process.env["DEVLET_RECONCILE_KOMODO_ORPHANS"] === "1";
let reconcilingOrphans = false;
async function reconcileOrphanedKomodo(): Promise<void> {
  if (!reconcileOrphansEnabled) return;
  if (reconcilingOrphans) return;
  reconcilingOrphans = true;
  try {
    const orphans = await listOrphanedKomodoDeployments();
    for (const name of orphans) {
      const log = await getOrphanedKomodoDeploymentLog(name);
      const tail = log.slice(-5).join(" | ");
      console.warn(
        `[reconcile] orphaned Komodo deployment ${name} — no agent state references it. ` +
          `Tearing down.${tail ? ` Last logs: ${tail}` : ""}`
      );
      await removeOrphanedKomodoDeployment(name).catch((err: unknown) => {
        console.error(`[reconcile] failed to remove ${name}:`, err instanceof Error ? err.message : err);
      });
    }
  } catch {
    // don't crash the server on reconciliation errors
  } finally {
    reconcilingOrphans = false;
  }
}

void reconcileOrphanedKomodo();
setInterval(reconcileOrphanedKomodo, 5 * 60_000);
