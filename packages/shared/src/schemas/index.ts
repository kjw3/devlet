import { z } from "zod";

// ─── Platform Targets ────────────────────────────────────────────────────────

export const DockerPlatformSchema = z.object({
  type: z.literal("docker"),
  socketPath: z.string().optional(),
});

export const PortainerPlatformSchema = z.object({
  type: z.literal("portainer"),
  endpointId: z.number().int().positive(),
  stackName: z.string().optional(),
});

export const ProxmoxPlatformSchema = z.object({
  type: z.literal("proxmox"),
  node: z.string().min(1),
  vmType: z.enum(["lxc", "qemu"]),
});

export const PlatformTargetSchema = z.discriminatedUnion("type", [
  DockerPlatformSchema,
  PortainerPlatformSchema,
  ProxmoxPlatformSchema,
]);

// ─── Mission ─────────────────────────────────────────────────────────────────

export const MissionStepSchema = z.object({
  action: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  description: z.string().optional(),
});

export const MissionSchema = z.object({
  description: z.string().min(1),
  steps: z.array(MissionStepSchema),
  onComplete: z.enum(["idle", "terminate", "report"]),
  timeout: z.number().int().positive().optional(),
});

// ─── Resources ───────────────────────────────────────────────────────────────

export const ResourceLimitsSchema = z.object({
  cpus: z.number().positive(),
  memoryMb: z.number().int().positive(),
  storageMb: z.number().int().positive().optional(),
});

// ─── GPU Requirements ─────────────────────────────────────────────────────────

export const GpuRequirementsSchema = z.object({
  required: z.boolean(),
  memoryMb: z.number().int().positive().optional(),
  passthroughMode: z.enum(["container", "vm"]).optional(),
});

// ─── Agent Config ─────────────────────────────────────────────────────────────

export const AgentTypeSchema = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "pi",
  "gemini",
  "openclaw",
  "nanoclaw",
  "hermes",
  "moltis",
  "nemoclaw",
]);

export const AgentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  type: AgentTypeSchema,
  role: z.string().min(1).max(256),
  mission: MissionSchema,
  /** Resolved placement — set by scheduler, not user input */
  platform: PlatformTargetSchema,
  resources: ResourceLimitsSchema,
  gpu: GpuRequirementsSchema.optional(),
  env: z.record(z.string()),
  persistent: z.boolean(),
  createdAt: z.string().datetime(),
  lastActiveAt: z.string().datetime(),
});

/**
 * Input schema for hiring a new agent.
 *
 * `platform` is intentionally omitted — the server runs the scheduler
 * authoritatively at hire time. The UI may pass `platformOverride` if
 * the user explicitly chose a platform in the hire wizard.
 */
export const HireAgentInputSchema = AgentConfigSchema.omit({
  id: true,
  createdAt: true,
  lastActiveAt: true,
  platform: true,
}).extend({
  /** If set, bypasses the scheduler and forces this placement. */
  platformOverride: PlatformTargetSchema.optional(),
});

// ─── Agent State ──────────────────────────────────────────────────────────────

export const AgentStatusSchema = z.enum([
  "provisioning",
  "bootstrapping",
  "running",
  "idle",
  "terminated",
  "error",
]);

export const MissionProgressSchema = z.object({
  currentStep: z.number().int().min(0),
  completed: z.array(z.number().int().min(0)),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

export const AgentStateSchema = z.object({
  config: AgentConfigSchema,
  status: AgentStatusSchema,
  platformRef: z.string(),
  missionProgress: MissionProgressSchema,
  logs: z.array(z.string()),
  error: z.string().optional(),
  access: z.object({
    terminal: z.object({
      url: z.string().url(),
      username: z.string().min(1),
      password: z.string().optional(),
    }).optional(),
    ssh: z.object({
      host: z.string().min(1),
      port: z.number().int().positive(),
      username: z.string().min(1),
      hostKeyFingerprint: z.string().min(1).optional(),
    }).optional(),
    openclaw: z.object({
      url: z.string().url(),
      token: z.string().optional(),
    }).optional(),
    moltis: z.object({
      url: z.string().url(),
    }).optional(),
  }).optional(),
});

// ─── Update Mission Input ─────────────────────────────────────────────────────

export const UpdateMissionInputSchema = z.object({
  agentId: z.string().min(1),
  mission: MissionSchema,
});

// ─── Model Configuration ──────────────────────────────────────────────────────

export const ProviderNameSchema = z.enum([
  "litellm",
  "openrouter",
  "anthropic",
  "openai",
  "gemini",
  "nvidia",
]);

export const ModelDefaultsSchema = z.object({
  defaults: z.record(ProviderNameSchema, z.string()).default({}),
});

export const SetDefaultInputSchema = z.object({
  provider: ProviderNameSchema,
  modelId: z.string().min(1),
});

// ─── Agent Type Configuration ─────────────────────────────────────────────────

export const SetAgentTypeConfigInputSchema = z.object({
  agentType: AgentTypeSchema,
  provider: ProviderNameSchema,
  /** Omit to use the provider's default from the Providers page. */
  model: z.string().min(1).optional(),
});

// ─── Platform Scheduling Exclusions ──────────────────────────────────────────

export const PlatformExclusionsSchema = z.object({
  portainerEndpoints: z.array(z.string()).default([]),
  proxmoxNodes: z.array(z.string()).default([]),
});

export const SetPortainerExclusionInputSchema = z.object({
  target: z.string().min(1),
  excluded: z.boolean(),
});

export const SetProxmoxExclusionInputSchema = z.object({
  target: z.string().min(1),
  excluded: z.boolean(),
});
