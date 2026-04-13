export type ProviderName = "litellm" | "openrouter" | "anthropic" | "openai" | "gemini" | "nvidia";

export interface ProviderModel {
  id: string;
  name?: string;
  contextLength?: number;
}

export interface ProviderInfo {
  id: ProviderName;
  /** Human-readable label */
  name: string;
  /** True if the required API key / base URL is present in server env */
  configured: boolean;
  /** Available models; empty when unconfigured or fetch failed */
  models: ProviderModel[];
  /** Currently saved default model for this provider */
  defaultModel?: string;
  /** Set when the provider is configured but the model-list fetch failed */
  error?: string;
}

export interface ModelDefaults {
  /** provider id → model id */
  defaults: Partial<Record<ProviderName, string>>;
}

export interface SetDefaultInput {
  provider: ProviderName;
  modelId: string;
}
