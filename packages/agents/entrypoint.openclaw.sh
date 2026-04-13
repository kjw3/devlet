#!/bin/bash
# devlet/agent-openclaw entrypoint
# Configures OpenClaw from devlet env vars and starts the gateway.
set -e

. /usr/local/bin/devlet-terminal

AGENT_NAME="${DEVLET_AGENT_NAME:-OpenClaw Agent}"
AGENT_ROLE="${DEVLET_AGENT_ROLE:-AI assistant}"
AGENT_MISSION="${DEVLET_AGENT_MISSION:-}"
PROVIDER="${DEVLET_AGENT_PROVIDER:-anthropic}"
MODEL="${DEVLET_AGENT_MODEL:-claude-sonnet-4-6}"

# Token — devlet server pre-generates and passes OPENCLAW_GATEWAY_TOKEN.
# Auto-generate a UUID only if the container is started without one (e.g. manually).
if [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
  export OPENCLAW_GATEWAY_TOKEN=$(node -e "const {randomUUID}=require('crypto');console.log(randomUUID())")
  echo "[devlet] WARNING: OPENCLAW_GATEWAY_TOKEN not set by server — auto-generated"
fi

echo "[devlet] openclaw agent=\"${AGENT_NAME}\" provider=$PROVIDER model=$MODEL"

# ─── Write openclaw.json via Node to handle special chars in name/role ────────
node - <<'JSEOF'
const fs   = require('fs');
const os   = require('os');
const home = os.homedir();

fs.mkdirSync(home + '/.openclaw', { recursive: true });

const provider = process.env.DEVLET_AGENT_PROVIDER || 'anthropic';
const model    = process.env.DEVLET_AGENT_MODEL    || 'claude-sonnet-4-6';
const name     = process.env.DEVLET_AGENT_NAME     || 'OpenClaw Agent';
const token    = process.env.OPENCLAW_GATEWAY_TOKEN;

const config = {
  gateway: {
    mode: 'local',
    bind: 'lan',
    port: 18789,
    auth: {
      mode: 'token',
      token,
    },
  },
  ui: {
    assistant: { name },
  },
  agents: {
    defaults: {
      workspace: '/workspace',
      contextInjection: 'always',
      model: { primary: `${provider}/${model}` },
    },
    list: [
      {
        id: 'main',
        default: true,
        name,
        workspace: '/workspace',
        identity: { name, emoji: '🦞' },
      },
    ],
  },
};

fs.writeFileSync(home + '/.openclaw/openclaw.json', JSON.stringify(config, null, 2));
console.log('[devlet] openclaw.json written');
JSEOF

# ─── Write workspace bootstrap files ─────────────────────────────────────────
mkdir -p /workspace

node - <<'JSEOF'
const fs   = require('fs');

const name    = process.env.DEVLET_AGENT_NAME    || 'OpenClaw Agent';
const role    = process.env.DEVLET_AGENT_ROLE    || 'AI assistant';
const mission = process.env.DEVLET_AGENT_MISSION || '';

// IDENTITY.md — public-facing identity shown in Control UI
fs.writeFileSync('/workspace/IDENTITY.md', [
  '# Identity',
  '',
  `**Name:** ${name}`,
  `**Role:** ${role}`,
  '',
  '_Managed by devlet._',
].join('\n'));

// SOUL.md — behavioral persona injected into every session
fs.writeFileSync('/workspace/SOUL.md', [
  '# Soul',
  '',
  `You are **${name}**, an autonomous AI agent managed by devlet.`,
  '',
  '## Role',
  role,
  '',
  '## Behavior',
  '- Be direct, concise, and action-oriented.',
  '- Take autonomous action when a clear path exists.',
  '- Ask for clarification only when genuinely ambiguous.',
  '- Prefer doing over explaining.',
].join('\n'));

// AGENTS.md — mission instructions
const missionBlock = mission
  ? `## Primary Mission\n${mission}\n\n## Conduct\n- Execute the mission autonomously.\n- Report blockers clearly.\n- Summarize what was done when complete.`
  : '## Status\n\nNo mission assigned. Await instructions from the operator.';

fs.writeFileSync('/workspace/AGENTS.md', [
  '# Agent Instructions',
  '',
  missionBlock,
].join('\n'));

console.log('[devlet] Workspace bootstrap files written (IDENTITY.md, SOUL.md, AGENTS.md)');
JSEOF

# ─── Start OpenClaw gateway (foreground, becomes PID 1) ──────────────────────
exec openclaw gateway --allow-unconfigured
