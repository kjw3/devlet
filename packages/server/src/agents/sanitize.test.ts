import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeAgentStateSummary, sanitizeEnv } from "./sanitize.js";
import type { AgentState } from "@devlet/shared";

function sampleState(): AgentState {
  return {
    config: {
      id: "agent-abc1",
      name: "codex-agent",
      type: "codex",
      role: "Task executor",
      mission: { description: "Fix the failing test", steps: [], onComplete: "terminate" },
      platform: { type: "komodo", serverId: "srv-1" },
      resources: { cpus: 2, memoryMb: 2048 },
      env: {
        "DEVLET_AGENT_MISSION": "Fix the failing test",
        "MOLTIS_PASSWORD": "hunter2",
        "OPENCLAW_GATEWAY_TOKEN": "tok-123",
        "ANTHROPIC_API_KEY": "sk-ant-xyz",
        "DEVLET_SSH_HOST_KEY_PRIVATE_B64": "c2VjcmV0",
        "SAFE_VALUE": "kept",
      },
      persistent: false,
      createdAt: "2026-10-16T10:00:00.000Z",
      lastActiveAt: "2026-10-16T10:00:00.000Z",
    },
    status: "running",
    platformRef: "komodo:srv-1:deployment",
    missionProgress: { currentStep: 0, completed: [], startedAt: "2026-10-16T10:00:00.000Z" },
    logs: ["[devlet] agent-type=codex"],
    access: {
      terminal: { url: "https://terminal.example.com/" },
      ssh: { host: "10.0.0.5", port: 2222, username: "agent" },
    },
  };
}

test("list summaries strip access and redact secrets without any async/remote work", () => {
  const summary = sanitizeAgentStateSummary(sampleState());

  // Access is detail-only: never serialized in the list path.
  assert.equal(summary.access, undefined);
  // Secrets and internal-only env values are removed or redacted.
  assert.equal(summary.config.env["MOLTIS_PASSWORD"], undefined);
  assert.equal(summary.config.env["OPENCLAW_GATEWAY_TOKEN"], undefined);
  assert.equal(summary.config.env["ANTHROPIC_API_KEY"], "[redacted]");
  assert.equal(summary.config.env["DEVLET_SSH_HOST_KEY_PRIVATE_B64"], undefined);
  assert.equal(summary.config.env["SAFE_VALUE"], "kept");
  // Everything else passes through untouched.
  assert.equal(summary.config.name, "codex-agent");
  assert.equal(summary.status, "running");
  assert.equal(summary.platformRef, "komodo:srv-1:deployment");
});

test("summaries do not mutate the input state", () => {
  const state = sampleState();
  sanitizeAgentStateSummary(state);
  assert.equal(state.config.env["MOLTIS_PASSWORD"], "hunter2");
  assert.ok(state.access);
});

test("env sanitization hides internal-only keys and secret-shaped values", () => {
  const env = sanitizeEnv({
    "DEVLET_TERMINAL_PORT": "7681",
    "MY_SERVICE_TOKEN": "t",
    "DATABASE_PASSWORD": "p",
    "GITHUB_SESSION": "s",
    "AWS_SECRET_ACCESS_KEY": "k",
    "PATH": "/usr/bin",
  });
  assert.deepEqual(env, {
    "MY_SERVICE_TOKEN": "[redacted]",
    "DATABASE_PASSWORD": "[redacted]",
    "GITHUB_SESSION": "[redacted]",
    "AWS_SECRET_ACCESS_KEY": "[redacted]",
    "PATH": "/usr/bin",
  });
});
