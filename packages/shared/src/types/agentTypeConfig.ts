import type { AgentType } from "./agent.js";
import type { ProviderName } from "./model.js";

export interface AgentTypeConfig {
  provider: ProviderName;
  /** Explicit model ID. When absent the provider's default (from Providers page) is used. */
  model?: string;
}

/** Saved provider + model defaults keyed by agent type. */
export interface AgentTypeConfigMap {
  configs: Partial<Record<AgentType, AgentTypeConfig>>;
}

export interface SetAgentTypeConfigInput {
  agentType: AgentType;
  provider: ProviderName;
  model?: string;
}
