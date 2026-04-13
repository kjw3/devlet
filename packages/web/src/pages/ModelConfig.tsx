import { useState } from "react";
import type { ProviderInfo } from "@devlet/shared";
import { trpc } from "../trpc.js";

// ─── Provider card ────────────────────────────────────────────────────────────

function ProviderCard({ provider }: { provider: ProviderInfo }) {
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState(provider.defaultModel ?? "");
  const [saved, setSaved] = useState(false);

  const setDefault = trpc.models.setDefault.useMutation({
    onSuccess: (updated) => {
      setSelected(updated.defaultModel ?? "");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      void utils.models.listProviders.invalidate();
    },
  });

  const isConfigured = provider.configured;
  const hasModels = provider.models.length > 0;

  return (
    <div className={`rounded-lg border p-4 flex flex-col gap-3 ${
      isConfigured ? "border-surface-border bg-surface-raised" : "border-surface-border/40 bg-surface-base opacity-60"
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
            isConfigured ? "bg-green-500" : "bg-gray-500"
          }`} />
          <span className="font-semibold text-sm text-text-primary">{provider.name}</span>
        </div>
        {!isConfigured && (
          <span className="label text-gray-500 text-[11px]">no API key</span>
        )}
      </div>

      {/* Error banner */}
      {provider.error && (
        <div className="text-[11px] text-yellow-500 bg-yellow-500/10 rounded px-2 py-1 border border-yellow-500/20">
          Failed to fetch models: {provider.error}
        </div>
      )}

      {/* Model selector */}
      {isConfigured && (
        <div className="flex gap-2 items-center">
          <select
            className="flex-1 bg-surface-base border border-surface-border rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent-cyan disabled:opacity-40"
            value={selected}
            onChange={(e) => { setSelected(e.target.value); setSaved(false); }}
            disabled={!hasModels}
          >
            {!selected && <option value="">— choose default model —</option>}
            {provider.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? m.id}
              </option>
            ))}
          </select>

          <button
            className="px-3 py-1.5 rounded text-xs font-medium bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/20 disabled:opacity-40 transition-colors"
            disabled={!selected || setDefault.isPending}
            onClick={() => {
              if (selected) setDefault.mutate({ provider: provider.id, modelId: selected });
            }}
          >
            {saved ? "Saved ✓" : setDefault.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      )}

      {/* Current default label */}
      {provider.defaultModel && (
        <div className="text-[11px] text-gray-500">
          Current default: <span className="text-text-primary font-mono">{provider.defaultModel}</span>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ModelConfig() {
  const { data: providers, isLoading, error } = trpc.models.listProviders.useQuery(
    undefined,
    { staleTime: 30_000 }
  );

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto flex flex-col gap-6">
        <div>
          <h1 className="text-lg font-bold text-text-primary">Providers</h1>
          <p className="text-xs text-gray-500 mt-1">
            Set the default model for each configured provider. Used by agents when no
            explicit model is configured on the Agents page.
          </p>
        </div>

        {isLoading && (
          <div className="label text-gray-500">Loading providers…</div>
        )}

        {error && (
          <div className="text-sm text-red-400">Failed to load providers: {error.message}</div>
        )}

        {providers && (
          <div className="flex flex-col gap-3">
            {providers.map((p) => (
              <ProviderCard key={p.id} provider={p} />
            ))}
          </div>
        )}

        <div className="text-[11px] text-gray-600 border-t border-surface-border pt-4">
          Provider priority (auto-detection order):{" "}
          {["LiteLLM", "OpenRouter", "Anthropic", "OpenAI", "Gemini"].join(" → ")}
        </div>
      </div>
    </div>
  );
}
