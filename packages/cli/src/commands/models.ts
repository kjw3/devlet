import { trpc } from "../client.js";
import type { ProviderName } from "@devlet/shared";

const PROVIDER_NAMES: Record<ProviderName, string> = {
  litellm:    "LiteLLM",
  openrouter: "OpenRouter",
  anthropic:  "Anthropic",
  openai:     "OpenAI",
  gemini:     "Gemini",
  nvidia:     "NVIDIA",
};

export async function modelsListCommand() {
  let providers;
  try {
    providers = await trpc.models.listProviders.query();
  } catch {
    console.error("error: cannot connect to devlet server (is it running?)");
    process.exit(1);
  }

  const header = [
    "PROVIDER".padEnd(14),
    "STATUS".padEnd(12),
    "DEFAULT MODEL".padEnd(36),
    "MODELS",
  ].join("  ");

  console.log(header);
  console.log("─".repeat(header.length));

  for (const p of providers) {
    const status = p.configured ? "● configured" : "○ no key";
    const defaultModel = p.defaultModel ? p.defaultModel : "—";
    const count = p.configured
      ? p.error
        ? `err: ${p.error.slice(0, 30)}`
        : `${p.models.length} available`
      : "";

    const row = [
      (PROVIDER_NAMES[p.id] ?? p.id).padEnd(14),
      status.padEnd(12),
      defaultModel.padEnd(36),
      count,
    ].join("  ");
    console.log(row);
  }
}

export async function modelsSetDefaultCommand(provider: string, modelId: string) {
  const validProviders: ProviderName[] = ["litellm", "openrouter", "anthropic", "openai", "gemini", "nvidia"];
  if (!validProviders.includes(provider as ProviderName)) {
    console.error(`error: unknown provider "${provider}". Valid: ${validProviders.join(", ")}`);
    process.exit(1);
  }

  try {
    const updated = await trpc.models.setDefault.mutate({
      provider: provider as ProviderName,
      modelId,
    });
    console.log(`✓ default for ${updated.name} set to ${modelId}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    process.exit(1);
  }
}
