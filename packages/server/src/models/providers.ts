import type { ProviderInfo, ProviderModel, ProviderName, ModelDefaults } from "@devlet/shared";


// ─── Provider metadata ────────────────────────────────────────────────────────

const PROVIDER_NAMES: Record<ProviderName, string> = {
  litellm:    "LiteLLM",
  openrouter: "OpenRouter",
  anthropic:  "Anthropic",
  openai:     "OpenAI",
  gemini:     "Gemini",
  nvidia:     "NVIDIA",
};

// ─── Configured provider detection ───────────────────────────────────────────

function getConfiguredProviders(): ProviderName[] {
  const providers: ProviderName[] = [];
  if (process.env["LITELLM_BASE_URL"] && process.env["LITELLM_API_KEY"]) providers.push("litellm");
  if (process.env["OPENROUTER_API_KEY"]) providers.push("openrouter");
  if (process.env["ANTHROPIC_API_KEY"]) providers.push("anthropic");
  if (process.env["OPENAI_API_KEY"])     providers.push("openai");
  if (process.env["GEMINI_API_KEY"])     providers.push("gemini");
  if (process.env["NVIDIA_API_KEY"])     providers.push("nvidia");
  return providers;
}

// ─── Model fetching ───────────────────────────────────────────────────────────

async function fetchLiteLLMModels(): Promise<ProviderModel[]> {
  const baseUrl = process.env["LITELLM_BASE_URL"]!;
  const apiKey  = process.env["LITELLM_API_KEY"]!;
  const res = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { data?: { id: string; object?: string }[] };
  return (json.data ?? []).map((m) => ({ id: m.id }));
}

async function fetchOpenRouterModels(): Promise<ProviderModel[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${process.env["OPENROUTER_API_KEY"]}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as {
    data?: { id: string; name?: string; context_length?: number }[];
  };
  return (json.data ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    contextLength: m.context_length,
  }));
}

async function fetchOpenAIModels(): Promise<ProviderModel[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${process.env["OPENAI_API_KEY"]}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { data?: { id: string }[] };
  // Filter to chat-capable models only; exclude embeddings, TTS, image, whisper, etc.
  const chatPattern = /^(gpt-|o1|o3|o4|chatgpt-)/;
  return (json.data ?? [])
    .filter((m) => chatPattern.test(m.id))
    .map((m) => ({ id: m.id }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

async function fetchAnthropicModels(): Promise<ProviderModel[]> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": process.env["ANTHROPIC_API_KEY"]!,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { data?: { id: string; display_name?: string }[] };
  return (json.data ?? []).map((m) => ({ id: m.id, name: m.display_name }));
}

async function fetchNvidiaModels(): Promise<ProviderModel[]> {
  const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
    headers: { Authorization: `Bearer ${process.env["NVIDIA_API_KEY"]}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { data?: { id: string }[] };
  return (json.data ?? []).map((m) => ({ id: m.id }));
}

async function fetchGeminiModels(): Promise<ProviderModel[]> {
  const apiKey = process.env["GEMINI_API_KEY"]!;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as {
    models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
  };
  return (json.models ?? [])
    // Only keep models that can generate content (excludes embedding, AQA, etc.)
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => ({
      // Strip the "models/" prefix to get a clean model ID
      id: m.name.replace(/^models\//, ""),
      name: m.displayName,
    }));
}

async function fetchModelsForProvider(provider: ProviderName): Promise<ProviderModel[]> {
  switch (provider) {
    case "litellm":    return fetchLiteLLMModels();
    case "openrouter": return fetchOpenRouterModels();
    case "openai":     return fetchOpenAIModels();
    case "anthropic":  return fetchAnthropicModels();
    case "gemini":     return fetchGeminiModels();
    case "nvidia":     return fetchNvidiaModels();
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function listProviders(defaults: ModelDefaults): Promise<ProviderInfo[]> {
  const configured = getConfiguredProviders();
  const allProviders: ProviderName[] = ["litellm", "openrouter", "anthropic", "openai", "gemini", "nvidia"];

  return Promise.all(
    allProviders.map(async (id): Promise<ProviderInfo> => {
      const isConfigured = configured.includes(id);
      const base: ProviderInfo = {
        id,
        name: PROVIDER_NAMES[id],
        configured: isConfigured,
        models: [],
        defaultModel: defaults.defaults[id],
      };

      if (!isConfigured) return base;

      try {
        const models = await fetchModelsForProvider(id);
        return { ...base, models };
      } catch (err) {
        return {
          ...base,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );
}
