import type { AgentType } from "./types/agent.js";

export const AGENT_TYPES: AgentType[] = [
  "claude-code",
  "codex",
  "openclaw",
  "nemoclaw",
  "hermes",
];

export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  openclaw: "OpenClaw",
  nemoclaw: "NemoClaw",
  hermes: "Hermes",
};

export const AGENT_TYPE_DESCRIPTIONS: Record<AgentType, string> = {
  "claude-code": "Anthropic's Claude Code — code review, refactoring, feature dev",
  codex: "OpenAI Codex — code generation and completion tasks",
  openclaw: "OpenClaw — open-source general purpose agent",
  nemoclaw: "NemoClaw — NVIDIA NeMo-based specialized agent",
  hermes: "Hermes — lightweight task execution and orchestration agent",
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
  cpus: 2,
  memoryMb: 4096,
  storageMb: 10240,
} as const;

export const DEVLET_STATE_DIR = "~/.devlet/agents";
