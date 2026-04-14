#!/bin/bash
# devlet/agent-hermes entrypoint
# Configures Hermes from env vars and starts the agent.
set -e

. /usr/local/bin/devlet-terminal
. /usr/local/bin/devlet-ssh
. /usr/local/bin/devlet-coding-init

MISSION="${DEVLET_AGENT_MISSION:-}"
PERSISTENT="${DEVLET_AGENT_PERSISTENT:-false}"
PROVIDER="${DEVLET_AGENT_PROVIDER:-}"
MODEL="${DEVLET_AGENT_MODEL:-}"

echo "[devlet] hermes starting (persistent=$PERSISTENT)..."

HERMES_HOME="${HERMES_HOME:-${HOME}/.hermes}"
mkdir -p "$HERMES_HOME"

# ─── API keys → $HERMES_HOME/.env ────────────────────────────────────────────
# Hermes reads these at startup; put every key here so skills that need
# secondary APIs (FIRECRAWL, TAVILY, etc.) still work regardless of provider.
cat > "$HERMES_HOME/.env" <<EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
GROQ_API_KEY=${GROQ_API_KEY:-}
FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY:-}
TAVILY_API_KEY=${TAVILY_API_KEY:-}
EOF

# ─── config.yaml → model provider + name ─────────────────────────────────────
# Hermes config.yaml format:
#   model:
#     provider: "<provider>"   # anthropic | openrouter | custom | openai-codex | nous | …
#     name: "<model>"          # model name / alias
#     base_url: "<url>"        # custom endpoints only
#     api_key: "<key>"         # custom endpoints only (can also be in .env)
#
# Provider mapping from DEVLET_AGENT_PROVIDER:
#   litellm   → custom  (LiteLLM proxy = OpenAI-compatible custom endpoint)
#   openai    → custom  (when OPENAI_BASE_URL is set) or openai-codex
#   anthropic → anthropic
#   openrouter→ openrouter
#   nvidia    → custom  (NVIDIA NIM: integrate.api.nvidia.com/v1)
#   groq      → custom  (Groq: api.groq.com/openai/v1)
#   <empty>   → auto-detect from available keys

HERMES_PROVIDER=""
HERMES_NAME=""
HERMES_BASE_URL=""
HERMES_API_KEY=""

case "$PROVIDER" in
  litellm)
    HERMES_PROVIDER="custom"
    HERMES_NAME="${MODEL:-best}"
    HERMES_BASE_URL="${LITELLM_BASE_URL:-}"
    HERMES_API_KEY="${LITELLM_API_KEY:-}"
    ;;
  anthropic)
    HERMES_PROVIDER="anthropic"
    HERMES_NAME="${MODEL:-claude-sonnet-4-5-20251001}"
    ;;
  openrouter)
    HERMES_PROVIDER="openrouter"
    HERMES_NAME="${MODEL:-anthropic/claude-sonnet-4-5}"
    ;;
  openai)
    if [ -n "${OPENAI_BASE_URL:-}" ]; then
      HERMES_PROVIDER="custom"
      HERMES_BASE_URL="${OPENAI_BASE_URL}"
      HERMES_API_KEY="${OPENAI_API_KEY:-}"
    else
      HERMES_PROVIDER="openai-codex"
    fi
    HERMES_NAME="${MODEL:-gpt-4o}"
    ;;
  nvidia)
    # NVIDIA NIM — OpenAI-compatible custom endpoint
    HERMES_PROVIDER="custom"
    HERMES_NAME="${MODEL:-meta/llama-3.1-70b-instruct}"
    HERMES_BASE_URL="https://integrate.api.nvidia.com/v1"
    HERMES_API_KEY="${NVIDIA_API_KEY:-}"
    ;;
  groq)
    # Groq — OpenAI-compatible custom endpoint
    HERMES_PROVIDER="custom"
    HERMES_NAME="${MODEL:-llama-3.3-70b-versatile}"
    HERMES_BASE_URL="https://api.groq.com/openai/v1"
    HERMES_API_KEY="${GROQ_API_KEY:-}"
    ;;
  "")
    # No provider configured — pick best available from keys
    if [ -n "${LITELLM_BASE_URL:-}" ]; then
      HERMES_PROVIDER="custom"
      HERMES_NAME="${MODEL:-best}"
      HERMES_BASE_URL="${LITELLM_BASE_URL}"
      HERMES_API_KEY="${LITELLM_API_KEY:-}"
    elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
      HERMES_PROVIDER="anthropic"
      HERMES_NAME="${MODEL:-claude-sonnet-4-5-20251001}"
    elif [ -n "${OPENROUTER_API_KEY:-}" ]; then
      HERMES_PROVIDER="openrouter"
      HERMES_NAME="${MODEL:-anthropic/claude-sonnet-4-5}"
    elif [ -n "${OPENAI_API_KEY:-}" ]; then
      HERMES_PROVIDER="openai-codex"
      HERMES_NAME="${MODEL:-gpt-4o}"
    elif [ -n "${NVIDIA_API_KEY:-}" ]; then
      HERMES_PROVIDER="custom"
      HERMES_NAME="${MODEL:-meta/llama-3.1-70b-instruct}"
      HERMES_BASE_URL="https://integrate.api.nvidia.com/v1"
      HERMES_API_KEY="${NVIDIA_API_KEY}"
    elif [ -n "${GROQ_API_KEY:-}" ]; then
      HERMES_PROVIDER="custom"
      HERMES_NAME="${MODEL:-llama-3.3-70b-versatile}"
      HERMES_BASE_URL="https://api.groq.com/openai/v1"
      HERMES_API_KEY="${GROQ_API_KEY}"
    fi
    ;;
esac

if [ -z "$HERMES_PROVIDER" ]; then
  echo "[devlet] WARNING: no provider or API key detected — Hermes may fail to start"
else
  echo "[devlet] hermes provider: $HERMES_PROVIDER  model: $HERMES_NAME"

  # Build config.yaml — use Node to avoid heredoc quoting issues with URLs/keys
  # Schema (derived from Hermes source hermes_cli/auth.py):
  #   model:
  #     provider: "<provider>"   # custom | anthropic | openrouter | ...
  #     default: "<model>"       # model name / alias (NOT "name")
  #     base_url: "<url>/v1"     # custom/openai endpoints only
  #     api_key: "<key>"         # custom endpoints (falls back to OPENAI_API_KEY)
  node - <<JSEOF
const fs   = require('fs');
const home = process.env.HERMES_HOME || (process.env.HOME + '/.hermes');

// Normalise base_url: Hermes appends /chat/completions directly,
// so the URL must end with /v1 for OpenAI-compatible servers.
function normaliseBaseUrl(url) {
  if (!url) return '';
  url = url.replace(/\\/+$/, '');                 // strip trailing slashes
  if (!url.endsWith('/v1')) url += '/v1';
  return url;
}

const cfg = {
  model: {
    provider: '${HERMES_PROVIDER}',
    default:  '${HERMES_NAME}',
  }
};
const rawBase = '${HERMES_BASE_URL}';
const apiKey  = '${HERMES_API_KEY}';
if (rawBase) cfg.model.base_url = normaliseBaseUrl(rawBase);
if (apiKey)  cfg.model.api_key  = apiKey;

// Serialize as YAML (manual — no yaml dep needed for this simple shape)
let out = 'model:\n';
for (const [k, v] of Object.entries(cfg.model)) {
  out += \`  \${k}: "\${v}"\n\`;
}
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(home + '/config.yaml', out);
console.log('[devlet] config.yaml written to', home);
JSEOF
fi

# ─── Launch ───────────────────────────────────────────────────────────────────

if [ -n "$MISSION" ]; then
  hermes chat -q "$MISSION"
  if [ "$PERSISTENT" = "true" ]; then
    echo "[devlet] mission complete — idling (persistent=true)"
    exec tail -f /dev/null
  fi
elif [ "$PERSISTENT" = "true" ]; then
  exec tail -f /dev/null
else
  exec hermes
fi
