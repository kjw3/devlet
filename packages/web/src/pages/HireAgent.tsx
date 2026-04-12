import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentType, PlatformTarget } from "@devlet/shared";
import {
  AGENT_TYPES,
  AGENT_TYPE_LABELS,
  AGENT_TYPE_DESCRIPTIONS,
  DEFAULT_RESOURCE_LIMITS,
  scheduleAgent,
} from "@devlet/shared";
import { PlacementPreview } from "../components/PlacementPreview.js";
import {
  MOCK_DOCKER_STATUS,
  MOCK_PORTAINER_STATUS,
  MOCK_PROXMOX_STATUS,
} from "../mocks/platforms.js";

// ─── Wizard steps ─────────────────────────────────────────────────────────────
// Platform selection is GONE — the scheduler handles it.
type Step = "type" | "role" | "review";

const STEP_LABELS: Record<Step, string> = {
  type: "01 / agent type",
  role: "02 / role & mission",
  review: "03 / review & deploy",
};

const STEPS: Step[] = ["type", "role", "review"];

// ─── Form state ───────────────────────────────────────────────────────────────

interface FormState {
  name: string;
  type: AgentType | "";
  role: string;
  missionDescription: string;
  cpus: number;
  memoryMb: number;
  persistent: boolean;
  gpuRequired: boolean;
  gpuMemoryMb: number;
  /** Set when user explicitly overrides the scheduler's recommendation */
  platformOverride?: PlatformTarget;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: Step }) {
  const idx = STEPS.indexOf(current);
  return (
    <div className="flex items-center gap-3 mb-8">
      {STEPS.map((step, i) => (
        <div key={step} className="flex items-center gap-2">
          <div
            className={`w-5 h-5 rounded-sm text-[10px] font-bold flex items-center justify-center border transition-colors ${
              i < idx
                ? "bg-accent-cyan/20 border-accent-cyan/40 text-accent-cyan"
                : i === idx
                ? "bg-accent-cyan text-surface border-accent-cyan"
                : "bg-surface border-surface-border text-gray-600"
            }`}
          >
            {i < idx ? "✓" : i + 1}
          </div>
          {i < STEPS.length - 1 && (
            <div
              className={`w-8 h-px ${i < idx ? "bg-accent-cyan/40" : "bg-surface-border"}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function HireAgent() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("type");
  const [form, setForm] = useState<FormState>({
    name: "",
    type: "",
    role: "",
    missionDescription: "",
    cpus: DEFAULT_RESOURCE_LIMITS.cpus,
    memoryMb: DEFAULT_RESOURCE_LIMITS.memoryMb,
    persistent: true,
    gpuRequired: false,
    gpuMemoryMb: 8192,
  });

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function canAdvance() {
    if (step === "type") return form.type !== "";
    if (step === "role")
      return (
        form.name.trim() !== "" &&
        form.role.trim() !== "" &&
        form.missionDescription.trim() !== ""
      );
    return true;
  }

  function nextStep() {
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1]!);
  }

  function prevStep() {
    const idx = STEPS.indexOf(step);
    if (idx > 0) setStep(STEPS[idx - 1]!);
  }

  function deploy() {
    // TODO: trpc.agents.hire.useMutation() — pass form + platformOverride
    console.log("deploy", {
      ...form,
      gpu: form.gpuRequired
        ? { required: true, memoryMb: form.gpuMemoryMb }
        : undefined,
    });
    navigate("/");
  }

  // Build placement requirements from current form state for the preview
  const placementReqs =
    form.type !== ""
      ? {
          type: form.type as AgentType,
          resources: { cpus: form.cpus, memoryMb: form.memoryMb },
          persistent: form.persistent,
          ...(form.gpuRequired
            ? { gpu: { required: true, memoryMb: form.gpuMemoryMb } }
            : {}),
        }
      : null;

  // Compute final platform for the review summary
  const schedulerDecision =
    placementReqs
      ? scheduleAgent(placementReqs, {
          docker: MOCK_DOCKER_STATUS,
          portainer: MOCK_PORTAINER_STATUS,
          proxmox: MOCK_PROXMOX_STATUS,
        })
      : null;

  const resolvedPlatform =
    form.platformOverride ?? schedulerDecision?.placement;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-surface-border px-6 py-4 flex items-center gap-3">
        <button
          className="text-gray-600 hover:text-gray-300 transition-colors text-sm"
          onClick={() => navigate("/")}
        >
          ←
        </button>
        <div>
          <div className="mono-header text-base text-gray-100">hire agent</div>
          <div className="text-[11px] text-gray-500">{STEP_LABELS[step]}</div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-2xl mx-auto">
          <StepIndicator current={step} />

          {/* ── Step 1: Agent type ── */}
          {step === "type" && (
            <div>
              <h2 className="mono-header text-lg mb-1">Select Agent Type</h2>
              <p className="text-[12px] text-gray-500 mb-6">
                Choose the AI model this agent will run. Infrastructure is selected automatically.
              </p>
              <div className="space-y-2">
                {AGENT_TYPES.map((type) => (
                  <button
                    key={type}
                    onClick={() => update("type", type)}
                    className={`w-full text-left p-4 card border transition-colors ${
                      form.type === type
                        ? "border-accent-cyan/50 bg-accent-cyan/5"
                        : "hover:border-gray-600 hover:bg-surface-overlay"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-[13px] text-gray-100">
                        {AGENT_TYPE_LABELS[type]}
                      </div>
                      {form.type === type && (
                        <span className="text-accent-cyan text-xs">✓ selected</span>
                      )}
                    </div>
                    <div className="text-[11px] text-gray-500 mt-1">
                      {AGENT_TYPE_DESCRIPTIONS[type]}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Step 2: Role, mission, resources ── */}
          {step === "role" && (
            <div>
              <h2 className="mono-header text-lg mb-1">Assign Role & Mission</h2>
              <p className="text-[12px] text-gray-500 mb-6">
                Define what this agent should do. Resource requirements inform placement.
              </p>
              <div className="space-y-4">
                <div>
                  <label className="label block mb-1.5">agent name</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => update("name", e.target.value)}
                    placeholder="e.g. PR Reviewer"
                    className="w-full bg-surface border border-surface-border rounded-sm px-3 py-2 text-[13px] text-gray-100 placeholder-gray-600 focus:outline-none focus:border-accent-cyan/50"
                  />
                </div>

                <div>
                  <label className="label block mb-1.5">role description</label>
                  <input
                    type="text"
                    value={form.role}
                    onChange={(e) => update("role", e.target.value)}
                    placeholder="e.g. Senior code reviewer specializing in TypeScript"
                    className="w-full bg-surface border border-surface-border rounded-sm px-3 py-2 text-[13px] text-gray-100 placeholder-gray-600 focus:outline-none focus:border-accent-cyan/50"
                  />
                </div>

                <div>
                  <label className="label block mb-1.5">mission objective</label>
                  <textarea
                    rows={3}
                    value={form.missionDescription}
                    onChange={(e) => update("missionDescription", e.target.value)}
                    placeholder="Describe what this agent should accomplish in natural language..."
                    className="w-full bg-surface border border-surface-border rounded-sm px-3 py-2 text-[13px] text-gray-100 placeholder-gray-600 focus:outline-none focus:border-accent-cyan/50 resize-none"
                  />
                </div>

                {/* Resources */}
                <div>
                  <div className="label mb-2">resource limits</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] text-gray-500 block mb-1">CPUs</label>
                      <input
                        type="number"
                        min={0.5}
                        max={32}
                        step={0.5}
                        value={form.cpus}
                        onChange={(e) => update("cpus", Number(e.target.value))}
                        className="w-full bg-surface border border-surface-border rounded-sm px-3 py-2 text-[13px] text-gray-100 focus:outline-none focus:border-accent-cyan/50"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-gray-500 block mb-1">Memory (MB)</label>
                      <input
                        type="number"
                        min={512}
                        max={65536}
                        step={512}
                        value={form.memoryMb}
                        onChange={(e) => update("memoryMb", Number(e.target.value))}
                        className="w-full bg-surface border border-surface-border rounded-sm px-3 py-2 text-[13px] text-gray-100 focus:outline-none focus:border-accent-cyan/50"
                      />
                    </div>
                  </div>
                </div>

                {/* GPU toggle */}
                <div className="card p-3 space-y-3">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      id="gpuRequired"
                      checked={form.gpuRequired}
                      onChange={(e) => update("gpuRequired", e.target.checked)}
                      className="w-3.5 h-3.5 accent-accent-cyan"
                    />
                    <label htmlFor="gpuRequired" className="text-[12px] text-gray-300 cursor-pointer">
                      Requires GPU
                    </label>
                    <span className="text-[11px] text-gray-600">
                      — scheduler will only consider GPU-capable platforms
                    </span>
                  </div>
                  {form.gpuRequired && (
                    <div className="pl-6">
                      <label className="text-[11px] text-gray-500 block mb-1">Min GPU memory (MB)</label>
                      <input
                        type="number"
                        min={1024}
                        max={81920}
                        step={1024}
                        value={form.gpuMemoryMb}
                        onChange={(e) => update("gpuMemoryMb", Number(e.target.value))}
                        className="w-40 bg-surface border border-surface-border rounded-sm px-3 py-1.5 text-[13px] text-gray-100 focus:outline-none focus:border-accent-cyan/50"
                      />
                    </div>
                  )}
                </div>

                {/* Persistence */}
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="persistent"
                    checked={form.persistent}
                    onChange={(e) => update("persistent", e.target.checked)}
                    className="w-3.5 h-3.5 accent-accent-cyan"
                  />
                  <label htmlFor="persistent" className="text-[12px] text-gray-300 cursor-pointer">
                    Persistent — survive restarts
                  </label>
                  <span className="text-[11px] text-gray-600">
                    — favours Portainer or Proxmox over ephemeral Docker containers
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* ── Step 3: Review + placement preview ── */}
          {step === "review" && (
            <div>
              <h2 className="mono-header text-lg mb-1">Review & Deploy</h2>
              <p className="text-[12px] text-gray-500 mb-6">
                Placement is selected automatically. Override only if needed.
              </p>

              {/* Config summary */}
              <div className="card p-4 mb-4">
                <div className="label mb-3">configuration</div>
                {[
                  { label: "name", val: form.name },
                  {
                    label: "type",
                    val: form.type
                      ? AGENT_TYPE_LABELS[form.type as AgentType]
                      : "",
                  },
                  { label: "role", val: form.role },
                  { label: "mission", val: form.missionDescription },
                  {
                    label: "resources",
                    val: `${form.cpus} CPUs · ${form.memoryMb}MB RAM${
                      form.gpuRequired ? ` · GPU ${form.gpuMemoryMb}MB+` : ""
                    }`,
                  },
                  { label: "persistent", val: form.persistent ? "yes" : "no" },
                ].map(({ label, val }) => (
                  <div
                    key={label}
                    className="flex gap-4 text-[12px] border-b border-surface-border last:border-0 py-2 last:pb-0 first:pt-0"
                  >
                    <span className="label w-20 flex-shrink-0 pt-0.5">{label}</span>
                    <span className="text-gray-300 break-words">{val}</span>
                  </div>
                ))}
              </div>

              {/* Placement preview */}
              <div className="mb-4">
                <div className="label mb-2">placement</div>
                {placementReqs && (
                  <PlacementPreview
                    requirements={placementReqs}
                    {...(form.platformOverride
                      ? { override: form.platformOverride }
                      : {})}
                    onPlacement={(p) => update("platformOverride", p)}
                  />
                )}
              </div>

              {/* Resolved platform callout */}
              {resolvedPlatform && (
                <div className="text-[11px] text-gray-600 flex items-center gap-1.5">
                  <span className="status-dot bg-status-running" />
                  Agent will be deployed on{" "}
                  <span className="text-gray-400">
                    {resolvedPlatform.type === "portainer"
                      ? `Portainer (endpoint ${resolvedPlatform.endpointId})`
                      : resolvedPlatform.type === "proxmox"
                      ? `Proxmox / ${resolvedPlatform.node} (${resolvedPlatform.vmType})`
                      : "Docker"}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Nav buttons */}
          <div className="flex justify-between mt-8">
            <button
              className="btn-ghost"
              onClick={step === "type" ? () => navigate("/") : prevStep}
            >
              {step === "type" ? "cancel" : "← back"}
            </button>
            {step === "review" ? (
              <button className="btn-primary" onClick={deploy}>
                deploy agent →
              </button>
            ) : (
              <button
                className="btn-primary"
                disabled={!canAdvance()}
                onClick={nextStep}
              >
                next →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
