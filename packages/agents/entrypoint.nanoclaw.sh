#!/bin/bash
# devlet/agent-nanoclaw entrypoint
# Configures NanoClaw from env vars and starts the runtime.
set -e

. /usr/local/bin/devlet-terminal
. /usr/local/bin/devlet-ssh
. /usr/local/bin/devlet-tailscale
. /usr/local/bin/devlet-coding-init
. /usr/local/bin/devlet-services

AGENT_NAME="${DEVLET_AGENT_NAME:-${ASSISTANT_NAME:-Andy}}"
AGENT_ROLE="${DEVLET_AGENT_ROLE:-AI assistant}"
AGENT_MISSION="${DEVLET_AGENT_MISSION:-}"

# ASSISTANT_NAME is what NanoClaw reads — keep in sync
export ASSISTANT_NAME="$AGENT_NAME"

echo "[devlet] nanoclaw starting (assistant=$AGENT_NAME)..."

# NanoClaw only speaks the Anthropic API. With no Anthropic key, use LiteLLM's
# Anthropic-compatible endpoint (and pin every model alias to a served model).
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -n "${LITELLM_BASE_URL:-}" ] && [ -n "${LITELLM_API_KEY:-}" ]; then
  export ANTHROPIC_BASE_URL="${LITELLM_BASE_URL%/}" ANTHROPIC_API_KEY="$LITELLM_API_KEY"
  _nc_model=$(_dci_litellm_model claude-code)
  if [ -n "$_nc_model" ]; then
    export ANTHROPIC_MODEL="$_nc_model" ANTHROPIC_DEFAULT_OPUS_MODEL="$_nc_model" \
           ANTHROPIC_DEFAULT_SONNET_MODEL="$_nc_model" ANTHROPIC_DEFAULT_HAIKU_MODEL="$_nc_model" \
           ANTHROPIC_SMALL_FAST_MODEL="$_nc_model"
  fi
  echo "[devlet] nanoclaw via LiteLLM model=${_nc_model:-<default>}"
fi

cd /nanoclaw

# ─── .env setup ───────────────────────────────────────────────────────────────
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
fi

# Use Node to safely write .env values (avoids shell quoting issues)
node - <<'JSEOF'
const fs   = require('fs');
const path = '/nanoclaw/.env';

let content = '';
try { content = fs.readFileSync(path, 'utf8'); } catch {}

function upsert(key, value) {
  if (!value) return;
  const re = new RegExp(`^${key}=.*`, 'm');
  const line = `${key}=${value}`;
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content += (content.endsWith('\n') ? '' : '\n') + line + '\n';
  }
}

upsert('ASSISTANT_NAME',    process.env.AGENT_NAME          || process.env.ASSISTANT_NAME);
upsert('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY);
upsert('ANTHROPIC_BASE_URL',process.env.ANTHROPIC_BASE_URL);
for (const k of ['ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_SMALL_FAST_MODEL']) upsert(k, process.env[k]);

fs.writeFileSync(path, content);
console.log('[devlet] .env written');
JSEOF

# ─── CLAUDE.md — system prompt / identity template ────────────────────────────
# NanoClaw copies this file into every new group folder at first message,
# so it becomes the persistent system prompt for all group sessions.
node - <<'JSEOF'
const fs      = require('fs');
const name    = process.env.AGENT_NAME    || 'Andy';
const role    = process.env.AGENT_ROLE    || 'AI assistant';
const mission = process.env.AGENT_MISSION || '';

const missionSection = mission
  ? `\n## Primary Mission\n\n${mission}\n\n- Execute the mission autonomously.\n- Report blockers clearly.\n- Summarize what was done when complete.`
  : '';

const content = `# ${name}

You are **${name}**, an autonomous AI agent managed by devlet.

## Role

${role}
${missionSection}

## Behavior

- Be direct, concise, and action-oriented.
- Take autonomous action when a clear path exists.
- Ask for clarification only when genuinely ambiguous.
- Prefer doing over explaining.
- When referencing yourself, use the name **${name}**.
`;

fs.writeFileSync('/nanoclaw/CLAUDE.md', content);
console.log('[devlet] CLAUDE.md written');
JSEOF

exec npm start
