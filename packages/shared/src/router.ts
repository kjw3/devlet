/**
 * tRPC Router Contract
 *
 * Claude Code defines the router shape here.
 * Codex implements the resolvers in packages/server.
 *
 * This file contains only the type-level router definition using
 * unimplemented procedures so the frontend can use it for type inference.
 */
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import {
  HireAgentInputSchema,
  AgentStateSchema,
  UpdateMissionInputSchema,
} from "./schemas/index.js";
import type {
  AgentState,
  DockerStatus,
  DockerImage,
  PortainerStatus,
  PortainerStack,
  ProxmoxStatus,
  AgentTemplate,
} from "./types/index.js";

const t = initTRPC.create();
const router = t.router;
const publicProcedure = t.procedure;

// ─── Stub helpers ─────────────────────────────────────────────────────────────
// These stubs exist only for type inference. The server replaces them with
// real implementations. Never call these directly.

function unimplemented(): never {
  throw new Error("Not implemented — backend resolver required");
}

// ─── Router definition ────────────────────────────────────────────────────────

export const appRouter = router({
  agents: router({
    list: publicProcedure.query(unimplemented as () => AgentState[]),

    get: publicProcedure
      .input(z.string())
      .query(unimplemented as () => AgentState),

    hire: publicProcedure
      .input(HireAgentInputSchema)
      .mutation(unimplemented as () => AgentState),

    fire: publicProcedure
      .input(z.string())
      .mutation(unimplemented as () => void),

    restart: publicProcedure
      .input(z.string())
      .mutation(unimplemented as () => AgentState),

    logs: publicProcedure
      .input(z.string())
      .query(unimplemented as () => string[]),

    updateMission: publicProcedure
      .input(UpdateMissionInputSchema)
      .mutation(unimplemented as () => AgentState),
  }),

  platforms: router({
    docker: router({
      status: publicProcedure.query(unimplemented as () => DockerStatus),
      images: publicProcedure.query(unimplemented as () => DockerImage[]),
    }),

    portainer: router({
      status: publicProcedure.query(unimplemented as () => PortainerStatus),
      stacks: publicProcedure.query(unimplemented as () => PortainerStack[]),
    }),

    proxmox: router({
      status: publicProcedure.query(unimplemented as () => ProxmoxStatus),
    }),
  }),

  templates: router({
    list: publicProcedure.query(unimplemented as () => AgentTemplate[]),
    get: publicProcedure
      .input(z.string())
      .query(unimplemented as () => AgentTemplate),
  }),
});

export type AppRouter = typeof appRouter;
