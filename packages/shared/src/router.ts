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
  SetDefaultInputSchema,
  SetAgentTypeConfigInputSchema,
  AgentTypeSchema,
  SetPortainerExclusionInputSchema,
  SetProxmoxExclusionInputSchema,
} from "./schemas/index.js";
import type {
  AgentState,
  DockerStatus,
  DockerImage,
  PortainerStatus,
  PortainerStack,
  ProxmoxStatus,
  AgentTemplate,
  ProviderInfo,
  AgentTypeConfigMap,
  PlatformExclusions,
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

    health: publicProcedure
      .input(z.string())
      .query(unimplemented as () => { ok: boolean; httpStatus: number } | null),

    hire: publicProcedure
      .input(HireAgentInputSchema)
      .mutation(unimplemented as () => AgentState),

    fire: publicProcedure
      .input(z.string())
      .mutation(unimplemented as () => void),

    delete: publicProcedure
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
      exclusions: publicProcedure.query(unimplemented as () => PlatformExclusions),
      setExcluded: publicProcedure
        .input(SetPortainerExclusionInputSchema)
        .mutation(unimplemented as () => PlatformExclusions),
    }),

    proxmox: router({
      status: publicProcedure.query(unimplemented as () => ProxmoxStatus),
      setExcluded: publicProcedure
        .input(SetProxmoxExclusionInputSchema)
        .mutation(unimplemented as () => PlatformExclusions),
    }),
  }),

  templates: router({
    list: publicProcedure.query(unimplemented as () => AgentTemplate[]),
    get: publicProcedure
      .input(z.string())
      .query(unimplemented as () => AgentTemplate),
  }),

  models: router({
    /** Returns all detectable providers with their available models and saved defaults. */
    listProviders: publicProcedure.query(unimplemented as () => ProviderInfo[]),

    /** Save a default model for a provider. Returns the updated ProviderInfo. */
    setDefault: publicProcedure
      .input(SetDefaultInputSchema)
      .mutation(unimplemented as () => ProviderInfo),
  }),

  agentConfig: router({
    /** Returns saved provider+model defaults keyed by agent type. */
    list: publicProcedure.query(unimplemented as () => AgentTypeConfigMap),

    /** Set the default provider+model for an agent type. */
    set: publicProcedure
      .input(SetAgentTypeConfigInputSchema)
      .mutation(unimplemented as () => AgentTypeConfigMap),

    /** Clear the saved config for an agent type (revert to auto-detect). */
    clear: publicProcedure
      .input(AgentTypeSchema)
      .mutation(unimplemented as () => AgentTypeConfigMap),
  }),
});

export type AppRouter = typeof appRouter;
