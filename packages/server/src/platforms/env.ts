import type { AgentConfig } from "@devlet/shared";
import { loadModelDefaults } from "../models/config.js";
import { loadAgentTypeConfig } from "../agents/typeConfig.js";

/**
 * Build the full env array for an agent container.
 *
 * Priority (lowest → highest):
 *   1. Devlet runtime vars (DEVLET_AGENT_TYPE, DEVLET_AGENT_MISSION, …)
 *   2. Platform-level API keys forwarded from the server's own process.env
 *   3. DEVLET_DEFAULT_MODEL injected from ~/.devlet/model-config.yaml
 *      (only when no per-agent override is present)
 *   4. Agent-specific env from AgentConfig.env (highest — set at hire time)
 */

// API keys the server forwards to every container it spawns.
// Agents that don't need a given key simply ignore it.
const FORWARDED_KEYS = [
  // LLM providers
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  // Custom base URLs / proxies
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "LITELLM_BASE_URL",
  "LITELLM_API_KEY",
  "NVIDIA_API_KEY",
  // Tool / search APIs used by some agents (e.g. Hermes)
  "FIRECRAWL_API_KEY",
  "TAVILY_API_KEY",
] as const;

const OPENCLAW_PROVIDER_KEYS: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
  openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  gemini: ["GEMINI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  litellm: ["LITELLM_BASE_URL", "LITELLM_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  groq: ["GROQ_API_KEY"],
} as const;

const SHARED_AGENT_TOOL_KEYS = [
  "FIRECRAWL_API_KEY",
  "TAVILY_API_KEY",
] as const;

const OPENCLAW_RUNTIME_KEYS = [
  "DEVLET_OPENCLAW_AUTO_PAIR",
] as const;

// Provider priority order — matches the entrypoint detection logic.
const PROVIDER_PRIORITY = ["litellm", "openrouter", "anthropic", "openai", "gemini", "nvidia"] as const;
type Provider = typeof PROVIDER_PRIORITY[number];

function detectActiveProvider(): Provider | null {
  if (process.env["LITELLM_BASE_URL"] && process.env["LITELLM_API_KEY"]) return "litellm";
  if (process.env["OPENROUTER_API_KEY"]) return "openrouter";
  if (process.env["ANTHROPIC_API_KEY"])  return "anthropic";
  if (process.env["OPENAI_API_KEY"])     return "openai";
  if (process.env["GEMINI_API_KEY"])     return "gemini";
  if (process.env["NVIDIA_API_KEY"])     return "nvidia";
  return null;
}

export async function buildContainerEnv(config: AgentConfig): Promise<string[]> {
  // 1. Devlet runtime vars
  const devletVars = [
    `DEVLET_AGENT_TYPE=${config.type}`,
    `DEVLET_AGENT_NAME=${config.name}`,
    `DEVLET_AGENT_ROLE=${config.role}`,
    `DEVLET_AGENT_PERSISTENT=${config.persistent}`,
    ...(config.mission.description
      ? [`DEVLET_AGENT_MISSION=${config.mission.description}`]
      : []),
  ];

  let resolvedProvider = config.env["DEVLET_AGENT_PROVIDER"] ?? null;

  // 2. Per-agent-type provider + model from ~/.devlet/agent-type-config.yaml
  //    Only injected when not already set by per-agent env overrides.
  const typeConfigVars: string[] = [];
  if (!config.env["DEVLET_AGENT_PROVIDER"] && !config.env["DEVLET_AGENT_MODEL"]) {
    try {
      const typeConfig = await loadAgentTypeConfig();
      const agentDefaults = typeConfig.configs[config.type];
      if (agentDefaults) {
        resolvedProvider = agentDefaults.provider;
        typeConfigVars.push(`DEVLET_AGENT_PROVIDER=${agentDefaults.provider}`);
        if (agentDefaults.model) {
          typeConfigVars.push(`DEVLET_AGENT_MODEL=${agentDefaults.model}`);
        } else {
          // No explicit model — fall back to this provider's default from Providers page
          const modelConfig = await loadModelDefaults();
          const providerDefault = modelConfig.defaults[agentDefaults.provider];
          if (providerDefault) {
            typeConfigVars.push(`DEVLET_AGENT_MODEL=${providerDefault}`);
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // 3. Platform-level API keys — only forward keys that are actually set.
  // OpenClaw is sensitive to multiple provider credentials being present at once,
  // so only pass the selected provider's credentials plus shared tool keys.
  const forwardedKeys =
    config.type === "openclaw" && resolvedProvider
      ? [
          ...(OPENCLAW_PROVIDER_KEYS[resolvedProvider] ?? []),
          ...SHARED_AGENT_TOOL_KEYS,
          ...OPENCLAW_RUNTIME_KEYS,
        ]
      : [...FORWARDED_KEYS];
  const platformKeys = [...new Set(forwardedKeys)]
    .filter((key) => process.env[key])
    .map((key) => `${key}=${process.env[key]}`);

  // 4. DEVLET_DEFAULT_MODEL fallback — skipped when a type-config model is already set
  const defaultModelVars: string[] = [];
  if (!config.env["DEVLET_DEFAULT_MODEL"] && typeConfigVars.length === 0) {
    try {
      const modelConfig = await loadModelDefaults();
      const activeProvider = detectActiveProvider();
      if (activeProvider) {
        const savedModel = modelConfig.defaults[activeProvider];
        if (savedModel) {
          defaultModelVars.push(`DEVLET_DEFAULT_MODEL=${savedModel}`);
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // 5. Agent-specific env — takes precedence over everything above
  const agentEnv = Object.entries(config.env).map(([k, v]) => `${k}=${v}`);

  return [...devletVars, ...platformKeys, ...typeConfigVars, ...defaultModelVars, ...agentEnv];
}
