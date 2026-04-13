import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentType, PlatformTarget } from "@devlet/shared";
import {
  AGENT_TYPES,
  AGENT_TYPE_LABELS,
  AGENT_TYPE_DESCRIPTIONS,
  DEFAULT_RESOURCE_LIMITS,
  AGENT_RESOURCE_MINS,
  AGENT_RESOURCE_DEFAULTS,
  scheduleAgent,
} from "@devlet/shared";
import { PlacementPreview } from "../components/PlacementPreview.js";
import { trpc } from "../trpc.js";

// ─── Agent icons ──────────────────────────────────────────────────────────────

const AGENT_ICONS: Record<string, React.ReactNode> = {
  // Official Claude AI symbol (Wikimedia Commons CC0, viewBox 0 0 1200 1200)
  "claude-code": (
    <svg viewBox="0 0 1200 1200" xmlns="http://www.w3.org/2000/svg" className="w-9 h-9" fill="#d97757">
      <path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 Z"/>
    </svg>
  ),
  // Official OpenAI logo (svgl.app, viewBox 0 0 256 260)
  codex: (
    <svg viewBox="0 0 256 260" xmlns="http://www.w3.org/2000/svg" className="w-9 h-9" fill="rgba(255,255,255,0.85)">
      <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z"/>
    </svg>
  ),
  // Official OpenCode logo favicon (opencode.ai/favicon.svg, viewBox 0 0 512 512)
  opencode: (
    <svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" className="w-9 h-9" fill="none">
      <path fillRule="evenodd" clipRule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="rgba(255,255,255,0.85)"/>
    </svg>
  ),
  // Custom π icon — pi is a devlet-native agent with no upstream logo
  pi: (
    <svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-9 h-9">
      <circle cx="18" cy="18" r="13" fill="rgba(139,92,246,0.1)" stroke="rgba(139,92,246,0.3)" strokeWidth="1"/>
      <path d="M10 14H26" stroke="#8B5CF6" strokeWidth="2" strokeLinecap="round"/>
      <path d="M14 14V24" stroke="#8B5CF6" strokeWidth="2" strokeLinecap="round"/>
      <path d="M22 14C22 14 24 18 24 21C24 23 23 25 23 25" stroke="#8B5CF6" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  ),
  // Official Google Gemini logo (simple-icons, viewBox 0 0 24 24)
  gemini: (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="w-9 h-9" fill="#4285F4">
      <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/>
    </svg>
  ),
  // Official OpenClaw icon (homarr-labs/dashboard-icons)
  openclaw: (
    <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-9 h-9">
      <defs>
        <linearGradient id="oc-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ff4d4d"/>
          <stop offset="100%" stopColor="#991b1b"/>
        </linearGradient>
      </defs>
      <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#oc-grad)"/>
      <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="url(#oc-grad)"/>
      <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="url(#oc-grad)"/>
      <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round"/>
      <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round"/>
      <circle cx="45" cy="35" r="6" fill="#050810"/>
      <circle cx="75" cy="35" r="6" fill="#050810"/>
      <circle cx="46" cy="34" r="2.5" fill="#00e5cc"/>
      <circle cx="76" cy="34" r="2.5" fill="#00e5cc"/>
    </svg>
  ),
  nanoclaw: (
    <svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-9 h-9">
      <ellipse cx="18" cy="18" rx="13" ry="5.5" stroke="rgba(20,184,166,0.45)" strokeWidth="1.2"/>
      <ellipse cx="18" cy="18" rx="13" ry="5.5" stroke="rgba(20,184,166,0.45)" strokeWidth="1.2" transform="rotate(60 18 18)"/>
      <ellipse cx="18" cy="18" rx="13" ry="5.5" stroke="rgba(20,184,166,0.45)" strokeWidth="1.2" transform="rotate(120 18 18)"/>
      <circle cx="18" cy="18" r="2.5" fill="#14B8A6"/>
    </svg>
  ),
  // Hermes (Nous Research) — custom amber lightning bolt, messenger-god motif
  hermes: (
    <svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-9 h-9">
      <circle cx="18" cy="18" r="13" fill="rgba(245,158,11,0.1)" stroke="rgba(245,158,11,0.25)" strokeWidth="1"/>
      <path d="M20.5 8L11 20H18L15.5 28L25 16H18L20.5 8Z" fill="#F59E0B"/>
    </svg>
  ),
  // Official Moltis favicon (moltis-org/moltis-website)
  moltis: (
    <svg viewBox="30 31 100 100" xmlns="http://www.w3.org/2000/svg" className="w-9 h-9" fill="none">
      <defs>
        <linearGradient id="mo-shell" x1="40" y1="40" x2="120" y2="110" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#f97316"/>
          <stop offset="100%" stopColor="#ea580c"/>
        </linearGradient>
        <linearGradient id="mo-claw" x1="0" y1="0" x2="50" y2="50" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fb923c"/>
          <stop offset="100%" stopColor="#ea580c"/>
        </linearGradient>
        <radialGradient id="mo-belly" cx="80" cy="85" r="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fed7aa"/>
          <stop offset="100%" stopColor="#fdba74"/>
        </radialGradient>
      </defs>
      <line x1="44" y1="88" x2="32" y2="98" stroke="#ea580c" strokeWidth="4" strokeLinecap="round" opacity="0.7"/>
      <line x1="42" y1="95" x2="28" y2="110" stroke="#ea580c" strokeWidth="3.5" strokeLinecap="round" opacity="0.6"/>
      <line x1="44" y1="101" x2="34" y2="122" stroke="#ea580c" strokeWidth="3" strokeLinecap="round" opacity="0.5"/>
      <line x1="116" y1="88" x2="128" y2="98" stroke="#ea580c" strokeWidth="4" strokeLinecap="round" opacity="0.7"/>
      <line x1="118" y1="95" x2="132" y2="110" stroke="#ea580c" strokeWidth="3.5" strokeLinecap="round" opacity="0.6"/>
      <line x1="116" y1="101" x2="126" y2="122" stroke="#ea580c" strokeWidth="3" strokeLinecap="round" opacity="0.5"/>
      <path d="M42 64 Q34 58 30 54 Q28 52 30 50 Q32 49 34 51 Q36 54 38 56" fill="url(#mo-claw)" stroke="url(#mo-claw)" strokeWidth="2" strokeLinecap="round"/>
      <path d="M118 64 Q126 58 130 54 Q132 52 130 50 Q128 49 126 51 Q124 54 122 56" fill="url(#mo-claw)" stroke="url(#mo-claw)" strokeWidth="2" strokeLinecap="round"/>
      <ellipse cx="80" cy="76" rx="40" ry="32" fill="url(#mo-shell)"/>
      <ellipse cx="80" cy="82" rx="24" ry="18" fill="url(#mo-belly)" opacity="0.4"/>
      <ellipse cx="64" cy="48" rx="5" ry="10" fill="#f97316"/>
      <ellipse cx="96" cy="48" rx="5" ry="10" fill="#f97316"/>
      <ellipse cx="64" cy="54" rx="9" ry="10" fill="white"/>
      <ellipse cx="96" cy="54" rx="9" ry="10" fill="white"/>
      <ellipse cx="65" cy="54" rx="5" ry="6" fill="#1c1917"/>
      <ellipse cx="97" cy="54" rx="5" ry="6" fill="#1c1917"/>
      <ellipse cx="67" cy="51" rx="2" ry="2.5" fill="white" opacity="0.9"/>
      <ellipse cx="99" cy="51" rx="2" ry="2.5" fill="white" opacity="0.9"/>
      <path d="M68 80 Q80 90 92 80" stroke="#9a3412" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  ),
  // Official NVIDIA logo (simple-icons, viewBox 0 0 24 24)
  nemoclaw: (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="w-9 h-9" fill="#76B900">
      <path d="M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z"/>
    </svg>
  ),
};

const AGENT_TYPE_SUBTITLES: Record<string, string> = {
  "claude-code": "Anthropic",
  codex:         "OpenAI",
  opencode:      "any model",
  pi:            "mine",
  gemini:        "Google",
  openclaw:      "actually does things",
  nanoclaw:      "secure & lite",
  hermes:        "Nous Research",
  moltis:        "one binary",
  nemoclaw:      "NVIDIA",
};

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
    cpus: 0.5,
    memoryMb: 512,
    persistent: true,
    gpuRequired: false,
    gpuMemoryMb: 8192,
  });

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function selectType(type: AgentType) {
    const mins = AGENT_RESOURCE_MINS[type];
    setForm((prev) => ({
      ...prev,
      type,
      cpus: mins.cpus,
      memoryMb: mins.memoryMb,
    }));
  }

  function canAdvance() {
    if (step === "type") return form.type !== "";
    if (step === "role") {
      if (!form.name.trim() || !form.role.trim() || !form.missionDescription.trim()) return false;
      if (form.type) {
        const mins = AGENT_RESOURCE_MINS[form.type];
        if (form.cpus < mins.cpus || form.memoryMb < mins.memoryMb) return false;
      }
      return true;
    }
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

  const hireMutation = trpc.agents.hire.useMutation({
    onSuccess: () => navigate("/"),
  });

  // Live platform status for accurate scheduler preview
  const { data: dockerStatus } = trpc.platforms.docker.status.useQuery(undefined, { staleTime: 10_000 });
  const { data: portainerStatus } = trpc.platforms.portainer.status.useQuery(undefined, { staleTime: 10_000 });
  const { data: proxmoxStatus } = trpc.platforms.proxmox.status.useQuery(undefined, { staleTime: 10_000 });

  const liveContext = {
    ...(dockerStatus ? { docker: dockerStatus } : {}),
    ...(portainerStatus ? { portainer: portainerStatus } : {}),
    ...(proxmoxStatus ? { proxmox: proxmoxStatus } : {}),
  };

  function deploy() {
    if (form.type === "") return;
    hireMutation.mutate({
      name: form.name,
      type: form.type as AgentType,
      role: form.role,
      mission: {
        description: form.missionDescription,
        steps: [],
        onComplete: "idle",
      },
      resources: { cpus: form.cpus, memoryMb: form.memoryMb },
      ...(form.gpuRequired ? { gpu: { required: true, memoryMb: form.gpuMemoryMb } } : {}),
      env: {},
      persistent: form.persistent,
      ...(form.platformOverride ? { platformOverride: form.platformOverride } : {}),
    });
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

  // Compute final platform for the review summary (using live data when available)
  const schedulerDecision =
    placementReqs
      ? scheduleAgent(placementReqs, {
          docker: dockerStatus ?? null,
          portainer: portainerStatus ?? null,
          proxmox: proxmoxStatus ?? null,
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
              <p className="text-[12px] text-gray-500 mb-5">
                Choose the AI agent to deploy. Infrastructure is selected automatically.
              </p>
              <div className="grid grid-cols-5 gap-2">
                {AGENT_TYPES.map((type) => {
                  const selected = form.type === type;
                  return (
                    <button
                      key={type}
                      onClick={() => selectType(type)}
                      title={AGENT_TYPE_DESCRIPTIONS[type]}
                      className={`flex flex-col items-center gap-2 p-3 rounded-lg border transition-all ${
                        selected
                          ? "border-accent-cyan/60 bg-accent-cyan/8 shadow-[0_0_12px_rgba(6,182,212,0.15)]"
                          : "border-surface-border bg-surface-raised hover:border-gray-600 hover:bg-surface-overlay"
                      }`}
                    >
                      <div className="relative">
                        {AGENT_ICONS[type]}
                        {selected && (
                          <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-accent-cyan rounded-full flex items-center justify-center">
                            <svg viewBox="0 0 10 10" className="w-2 h-2" fill="none">
                              <path d="M2 5L4.5 7.5L8 3" stroke="black" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </span>
                        )}
                      </div>
                      <div className="text-center">
                        <div className={`text-[11px] font-semibold leading-tight ${selected ? "text-accent-cyan" : "text-gray-200"}`}>
                          {AGENT_TYPE_LABELS[type]}
                        </div>
                        <div className="text-[10px] text-gray-600 mt-0.5 leading-tight">
                          {AGENT_TYPE_SUBTITLES[type]}
                        </div>
                      </div>
                    </button>
                  );
                })}
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
                {form.type && (() => {
                  const mins = AGENT_RESOURCE_MINS[form.type as AgentType];
                  const cpuBelow = form.cpus < mins.cpus;
                  const memBelow = form.memoryMb < mins.memoryMb;
                  return (
                    <div>
                      <div className="label mb-2">resource limits</div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[11px] text-gray-500 block mb-1">CPUs</label>
                          <input
                            type="number"
                            min={mins.cpus}
                            max={32}
                            step={0.25}
                            value={form.cpus}
                            onChange={(e) => update("cpus", Number(e.target.value))}
                            className={`w-full bg-surface border rounded-sm px-3 py-2 text-[13px] text-gray-100 focus:outline-none focus:border-accent-cyan/50 ${
                              cpuBelow ? "border-red-500/60" : "border-surface-border"
                            }`}
                          />
                          <div className={`text-[10px] mt-0.5 ${cpuBelow ? "text-red-400" : "text-gray-600"}`}>
                            min {mins.cpus} CPU{cpuBelow ? " — below minimum" : ""}
                          </div>
                        </div>
                        <div>
                          <label className="text-[11px] text-gray-500 block mb-1">Memory (MB)</label>
                          <input
                            type="number"
                            min={mins.memoryMb}
                            max={65536}
                            step={256}
                            value={form.memoryMb}
                            onChange={(e) => update("memoryMb", Number(e.target.value))}
                            className={`w-full bg-surface border rounded-sm px-3 py-2 text-[13px] text-gray-100 focus:outline-none focus:border-accent-cyan/50 ${
                              memBelow ? "border-red-500/60" : "border-surface-border"
                            }`}
                          />
                          <div className={`text-[10px] mt-0.5 ${memBelow ? "text-red-400" : "text-gray-600"}`}>
                            min {mins.memoryMb} MB{memBelow ? " — below minimum" : ""}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}

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
                    context={liveContext}
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
              <button
                className="btn-primary"
                disabled={hireMutation.isPending}
                onClick={deploy}
              >
                {hireMutation.isPending ? "deploying..." : "deploy agent →"}
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
