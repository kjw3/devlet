import { useState } from "react";
import { trpc } from "../trpc.js";
import { AGENT_TYPE_LABELS } from "@devlet/shared";
import type { AgentType, ProviderName, ProviderInfo, AgentTypeConfig } from "@devlet/shared";

// Agent types shown on this page and the providers each supports
const CONFIGURABLE_AGENTS: { type: AgentType; providers: ProviderName[] }[] = [
  { type: "claude-code", providers: ["anthropic"] },
  { type: "codex",       providers: ["openai", "litellm", "nvidia"] },
  { type: "opencode",    providers: ["litellm", "openrouter", "anthropic", "openai", "gemini", "nvidia"] },
  { type: "pi",          providers: ["anthropic", "openai", "litellm", "gemini", "nvidia"] },
  { type: "gemini",      providers: ["gemini"] },
  { type: "openclaw",    providers: ["litellm", "openrouter", "anthropic", "openai", "gemini", "nvidia"] },
  { type: "hermes",      providers: ["litellm", "openrouter", "anthropic", "openai", "gemini", "nvidia"] },
  { type: "moltis",      providers: ["litellm", "openrouter", "anthropic", "openai", "gemini", "nvidia"] },
  { type: "nemoclaw",    providers: ["nvidia", "litellm", "openai"] },
];

const PROVIDER_LABELS: Record<ProviderName, string> = {
  litellm:    "LiteLLM",
  openrouter: "OpenRouter",
  anthropic:  "Anthropic",
  openai:     "OpenAI",
  gemini:     "Gemini",
  nvidia:     "NVIDIA",
};

interface AgentRowProps {
  agentType: AgentType;
  compatibleProviders: ProviderName[];
  allProviders: ProviderInfo[];
  current: AgentTypeConfig | undefined;
  onSave: (provider: ProviderName, model?: string) => void;
  onClear: () => void;
  isSaving: boolean;
  isClearing: boolean;
}

function AgentRow({
  agentType,
  compatibleProviders,
  allProviders,
  current,
  onSave,
  onClear,
  isSaving,
  isClearing,
}: AgentRowProps) {
  const [selectedProvider, setSelectedProvider] = useState<ProviderName | "">(
    current?.provider ?? ""
  );
  const [selectedModel, setSelectedModel] = useState<string>(current?.model ?? "");

  const availableProviders = compatibleProviders
    .map((id) => allProviders.find((p) => p.id === id))
    .filter((p): p is ProviderInfo => !!p && p.configured);

  const providerInfo = allProviders.find((p) => p.id === selectedProvider);
  const availableModels = providerInfo?.models ?? [];
  const providerDefault = providerInfo?.defaultModel;

  function handleProviderChange(pid: string) {
    const newProvider = pid as ProviderName | "";
    setSelectedProvider(newProvider);
    // Auto-populate with the provider's configured default if available
    const info = allProviders.find((p) => p.id === newProvider);
    setSelectedModel(info?.defaultModel ?? "");
  }

  const isDirty =
    selectedProvider !== (current?.provider ?? "") ||
    selectedModel !== (current?.model ?? "");

  const usingProviderDefault = !!selectedProvider && !selectedModel;

  return (
    <div className="card p-4">
      <div className="flex items-start gap-4">
        {/* Agent label */}
        <div className="w-28 flex-shrink-0 pt-1">
          <div className="text-[12px] text-gray-200 font-medium">
            {AGENT_TYPE_LABELS[agentType]}
          </div>
          <div className="text-[10px] text-gray-600 font-mono mt-0.5">{agentType}</div>
        </div>

        {/* Current config badge */}
        <div className="w-48 flex-shrink-0 pt-1">
          {current ? (
            <div className="text-[11px] text-accent-cyan font-mono leading-tight">
              {PROVIDER_LABELS[current.provider]}
              {current.model
                ? ` / ${current.model}`
                : <span className="text-gray-500 not-italic"> / provider default</span>}
            </div>
          ) : (
            <div className="text-[11px] text-gray-600 italic">auto-detect</div>
          )}
        </div>

        {/* Provider select */}
        <select
          value={selectedProvider}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="bg-surface border border-surface-border text-gray-300 text-[11px] rounded-sm px-2 py-1 focus:outline-none focus:border-accent-cyan w-32"
        >
          <option value="">— provider —</option>
          {availableProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {PROVIDER_LABELS[p.id]}
            </option>
          ))}
        </select>

        {/* Model select */}
        <div className="flex-1 min-w-0">
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={!selectedProvider}
            className="w-full bg-surface border border-surface-border text-gray-300 text-[11px] rounded-sm px-2 py-1 focus:outline-none focus:border-accent-cyan disabled:opacity-40"
          >
            <option value="">
              {providerDefault ? `— default: ${providerDefault} —` : "— model —"}
            </option>
            {availableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
            {selectedModel && !availableModels.find((m) => m.id === selectedModel) && (
              <option value={selectedModel}>{selectedModel}</option>
            )}
          </select>
          {usingProviderDefault && providerDefault && (
            <div className="text-[10px] text-gray-600 mt-0.5 pl-1">
              will use provider default: {providerDefault}
            </div>
          )}
          {usingProviderDefault && !providerDefault && (
            <div className="text-[10px] text-accent-yellow mt-0.5 pl-1">
              no default set — configure one in Providers
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 flex-shrink-0">
          <button
            className="btn-primary text-[11px] py-1 px-3"
            disabled={!selectedProvider || !isDirty || isSaving}
            onClick={() => onSave(selectedProvider as ProviderName, selectedModel || undefined)}
          >
            {isSaving ? "saving…" : "save"}
          </button>
          {current && (
            <button
              className="btn-ghost text-[11px] py-1 px-3"
              disabled={isClearing}
              onClick={onClear}
            >
              {isClearing ? "clearing…" : "clear"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function AgentConfig() {
  const utils = trpc.useUtils();

  const { data: configMap, isLoading: configLoading } =
    trpc.agentConfig.list.useQuery(undefined, { staleTime: 10_000 });

  const { data: providers = [], isLoading: providersLoading } =
    trpc.models.listProviders.useQuery(undefined, { staleTime: 30_000 });

  const [savingType, setSavingType] = useState<AgentType | null>(null);
  const [clearingType, setClearingType] = useState<AgentType | null>(null);

  const setMutation = trpc.agentConfig.set.useMutation({
    onSuccess: () => {
      void utils.agentConfig.list.invalidate();
      setSavingType(null);
    },
    onError: () => setSavingType(null),
  });

  const clearMutation = trpc.agentConfig.clear.useMutation({
    onSuccess: () => {
      void utils.agentConfig.list.invalidate();
      setClearingType(null);
    },
    onError: () => setClearingType(null),
  });

  if (configLoading || providersLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 text-[12px] animate-pulse">
        loading…
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h2 className="mono-header text-base text-gray-100 mb-1">Agent Configuration</h2>
          <p className="text-[12px] text-gray-500 leading-relaxed">
            Set the default provider and model for each agent type. Leave model empty to use
            the provider's default configured in the Providers page. Agents without any
            saved configuration auto-detect the best available provider at launch time.
          </p>
        </div>

        <div className="space-y-2">
          {CONFIGURABLE_AGENTS.map(({ type, providers: compatibleProviders }) => (
            <AgentRow
              key={type}
              agentType={type}
              compatibleProviders={compatibleProviders}
              allProviders={providers}
              current={configMap?.configs[type]}
              isSaving={savingType === type}
              isClearing={clearingType === type}
              onSave={(provider, model) => {
                setSavingType(type);
                setMutation.mutate({ agentType: type, provider, model });
              }}
              onClear={() => {
                setClearingType(type);
                clearMutation.mutate(type);
              }}
            />
          ))}
        </div>

        <p className="text-[11px] text-gray-600">
          Per-agent overrides set at hire time take precedence over these defaults.
        </p>
      </div>
    </div>
  );
}
