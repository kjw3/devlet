import type { AgentType } from "./types/agent.js";

export const AGENT_TYPES: AgentType[] = [
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
];

export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  "claude-code": "Claude Code",
  codex:         "Codex",
  opencode:      "OpenCode",
  pi:            "Pi",
  gemini:        "Gemini",
  openclaw:      "OpenClaw",
  nanoclaw:      "NanoClaw",
  hermes:        "Hermes",
  moltis:        "Moltis",
  nemoclaw:      "NemoClaw",
};

export const AGENT_TYPE_DESCRIPTIONS: Record<AgentType, string> = {
  "claude-code": "Anthropic Claude Code — autonomous coding & refactoring agent",
  codex:         "OpenAI Codex CLI — code generation via GPT models",
  opencode:      "OpenCode (opencode.ai) — multi-provider open-source coding agent",
  pi:            "Pi coding agent — lightweight Anthropic/OpenAI coding harness",
  gemini:        "Google Gemini CLI — agentic AI coding assistant powered by Gemini models",
  openclaw:      "OpenClaw — interactive gateway agent with multi-channel orchestration",
  nanoclaw:      "NanoClaw — lightweight Agents SDK agent orchestrated by Claude Code (requires Proxmox)",
  hermes:        "Hermes (Nous Research) — autonomous multi-modal task agent",
  moltis:        "Moltis — persistent AI agent gateway with GraphQL API and multi-provider support",
  nemoclaw:      "NemoClaw — NVIDIA NeMo agent (Proxmox GPU VM, coming soon)",
};

export const STATUS_COLORS = {
  provisioning: "yellow",
  bootstrapping: "blue",
  running: "green",
  idle: "gray",
  terminated: "slate",
  error: "red",
} as const;

export const DEFAULT_RESOURCE_LIMITS = {
  cpus: 1,
  memoryMb: 1024,
  storageMb: 10240,
} as const;

/** Minimum resources required per agent type (enforced on client + server). */
export const AGENT_RESOURCE_MINS: Record<AgentType, { cpus: number; memoryMb: number }> = {
  "claude-code": { cpus: 0.5,  memoryMb: 512  },
  codex:         { cpus: 0.5,  memoryMb: 512  },
  opencode:      { cpus: 0.5,  memoryMb: 512  },
  pi:            { cpus: 0.5,  memoryMb: 512  },
  gemini:        { cpus: 0.5,  memoryMb: 512  },
  openclaw:      { cpus: 0.5,  memoryMb: 512  },
  nanoclaw:      { cpus: 0.25, memoryMb: 256  },
  hermes:        { cpus: 0.5,  memoryMb: 512  },
  moltis:        { cpus: 0.5,  memoryMb: 512  },
  nemoclaw:      { cpus: 1.0,  memoryMb: 1024 },
};

/** Recommended default resources per agent type (pre-filled in the hire wizard). */
export const AGENT_RESOURCE_DEFAULTS: Record<AgentType, { cpus: number; memoryMb: number }> = {
  "claude-code": { cpus: 1,   memoryMb: 1024 },
  codex:         { cpus: 1,   memoryMb: 1024 },
  opencode:      { cpus: 1,   memoryMb: 1024 },
  pi:            { cpus: 1,   memoryMb: 1024 },
  gemini:        { cpus: 1,   memoryMb: 1024 },
  openclaw:      { cpus: 1,   memoryMb: 1024 },
  nanoclaw:      { cpus: 0.5, memoryMb: 512  },
  hermes:        { cpus: 1,   memoryMb: 1024 },
  moltis:        { cpus: 1,   memoryMb: 1024 },
  nemoclaw:      { cpus: 2,   memoryMb: 2048 },
};

export const DEVLET_STATE_DIR = "~/.devlet/agents";
