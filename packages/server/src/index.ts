import { Readable } from "node:stream";
import cors from "@fastify/cors";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./routers/index.js";
import { getAgentRunning } from "./platforms/dispatch.js";
import { listAgentStates, saveAgentState } from "./agents/state.js";

const server = Fastify();
const authToken = process.env["DEVLET_AUTH_TOKEN"];

if (!authToken) {
  throw new Error("DEVLET_AUTH_TOKEN must be set before starting the server");
}

await server.register(cors, {
  origin: "http://localhost:3000",
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

await server.listen({
  port: 3001,
  host: "0.0.0.0",
});

console.log("Devlet server listening on http://localhost:3001");

// ─── Background: sync agent status when containers exit ───────────────────────
async function syncAgentStatuses(): Promise<void> {
  try {
    const states = await listAgentStates();
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
