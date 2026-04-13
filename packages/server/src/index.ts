import { Readable } from "node:stream";
import httpProxy from "http-proxy";
import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./routers/index.js";
import { getAgentRunning } from "./platforms/dispatch.js";
import { probePortainer } from "./platforms/portainer.js";
import { listAgentStates, loadAgentState, saveAgentState } from "./agents/state.js";
import { validateAgentProxyToken, resolveSurfaceTargetUrl, type AgentAccessSurface } from "./agent-access.js";
import { config } from "./config.js";

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
  | { ok: true; targetUrl: string; rewrittenPath: string }
  | { ok: false; statusCode: number; message: string };

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

  const suffix = parts.slice(4).join("/");
  const pathname = suffix ? `/${suffix}` : "/";
  const query = parsed.searchParams.toString();

  return {
    ok: true,
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

server.all("/trpc/*", async (request: FastifyRequest, reply: FastifyReply) => {
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
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
  agentUiProxy.web(request.raw, reply.raw, { target: resolution.targetUrl });
});

server.all("/agent-access/:agentId/:surface/:proxyToken/*", async (request: FastifyRequest, reply: FastifyReply) => {
  const resolution = await resolveAgentProxyRequest(request.url);
  if (!resolution.ok) {
    reply.code(resolution.statusCode);
    return reply.send(resolution.message);
  }

  request.raw.url = resolution.rewrittenPath;
  reply.hijack();
  agentUiProxy.web(request.raw, reply.raw, { target: resolution.targetUrl });
});

server.server.on("upgrade", async (request, socket, head) => {
  const resolution = await resolveAgentProxyRequest(request.url ?? "/");
  if (!resolution.ok) {
    socket.write(`HTTP/1.1 ${resolution.statusCode} ${resolution.message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  request.url = resolution.rewrittenPath;
  agentUiProxy.ws(request, socket, head, { target: resolution.targetUrl });
});

await server.listen({
  port: 3001,
  host: "0.0.0.0",
});

console.log("Devlet server listening on http://localhost:3001");

// ─── Background: sync agent status when containers exit ───────────────────────
async function syncAgentStatuses(): Promise<void> {
  try {
    const states = await listAgentStates();
    const portainerStatus = await probePortainer().catch(() => null);
    await Promise.all(
      states
        .filter((s) => s.status === "running")
        .map(async (state) => {
          try {
            const running = await getAgentRunning(state.platformRef);
            if (running === false) {
              state.status = "terminated";
              state.logs.push("[devlet] container exited — marked terminated");
              await saveAgentState(state);
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
          } catch {
            // ignore transient errors — don't update state on polling failure
          }
        })
    );
  } catch {
    // don't crash the server on state read errors
  }
}

setInterval(syncAgentStatuses, 15_000);
