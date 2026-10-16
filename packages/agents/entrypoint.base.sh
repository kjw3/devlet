#!/bin/bash
# devlet/agent-base entrypoint
# Dispatches to the agent selected by DEVLET_AGENT_TYPE.
set -e

# ─── Background daemons + coding tool init ───────────────────────────────────
. /usr/local/bin/devlet-terminal
. /usr/local/bin/devlet-ssh
. /usr/local/bin/devlet-tailscale
. /usr/local/bin/devlet-coding-init
. /usr/local/bin/devlet-services

AGENT_TYPE="${DEVLET_AGENT_TYPE:-claude-code}"
MISSION="${DEVLET_AGENT_MISSION:-}"
PERSISTENT="${DEVLET_AGENT_PERSISTENT:-false}"
PROVIDER="${DEVLET_AGENT_PROVIDER:-}"
MODEL="${DEVLET_AGENT_MODEL:-}"

# Set provider-specific model env vars from DEVLET_AGENT_MODEL if provided.
if [ -n "$MODEL" ]; then
  case "${PROVIDER:-anthropic}" in
    anthropic) export ANTHROPIC_MODEL="$MODEL" ;;
    openai)    export OPENAI_MODEL="$MODEL" ;;
    litellm)   export LITELLM_MODEL="$MODEL" ;;
  esac
fi

echo "[devlet] agent-type=$AGENT_TYPE provider=$PROVIDER persistent=$PERSISTENT mission=${MISSION:+(set)}"

# GPU probe — one line in the agent log (only present in the GPU image layer).
if [ -x /usr/local/bin/devlet-gpu-check ]; then
  /usr/local/bin/devlet-gpu-check || true
fi

# Git identity — required for any agent that commits code
git config --global user.email "agent@devlet" 2>/dev/null || true
git config --global user.name "Devlet Agent" 2>/dev/null || true

# Initialise workspace as a git repo if it isn't one already
if [ ! -d "/workspace/.git" ]; then
  git -C /workspace init -q
fi

# Helper: after a mission completes, either idle (persistent) or exit naturally
keep_alive_if_persistent() {
  if [ "$PERSISTENT" = "true" ]; then
    echo "[devlet] mission complete — idling (persistent=true)"
    exec tail -f /dev/null
  fi
}

# Helper: report mission lifecycle events to the devlet server.
# Fire-and-forget (backgrounded, short timeout): a slow or unreachable server
# must never delay or fail the mission. Events carry no mission content.
report_mission_event() {
  if [ -n "${DEVLET_SERVER_URL:-}" ] && [ -n "${DEVLET_AGENT_ID:-}" ] && [ -n "${DEVLET_AGENT_EVENT_TOKEN:-}" ]; then
    curl -sS -m 5 -o /dev/null \
      -H 'content-type: application/json' \
      -d "{\"agentId\":\"$DEVLET_AGENT_ID\",\"token\":\"$DEVLET_AGENT_EVENT_TOKEN\",\"event\":\"$1\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
      "$DEVLET_SERVER_URL/api/agent-event" >/dev/null 2>&1 &
  fi
}

# Helper: run the mission command with lifecycle reporting (started → completed/failed).
execute_mission() {
  report_mission_event mission_started
  set +e
  "$@"
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    report_mission_event mission_completed
  else
    report_mission_event mission_failed
  fi
  return "$rc"
}

# ─── Agent-type exec-time setup ──────────────────────────────────────────────
# devlet-coding-init (sourced above) handled common tool pre-configuration.
# Here we only resolve the variables the exec phase needs (CODEX_* / OPENCODE_MODEL)
# when the primary agent type is codex or opencode, respecting DEVLET_AGENT_PROVIDER
# and DEVLET_AGENT_MODEL so the requested model is honoured.

case "$AGENT_TYPE" in
  codex)
    case "$PROVIDER" in
      openai)
        CODEX_API_KEY="${OPENAI_API_KEY:-}"; CODEX_BASE_URL=""; CODEX_MODEL="${MODEL:-${DEVLET_DEFAULT_MODEL:-o4-mini}}";;
      litellm)
        CODEX_API_KEY="${LITELLM_API_KEY:-}"; CODEX_BASE_URL="${LITELLM_BASE_URL}/v1"; CODEX_MODEL="${MODEL:-${DEVLET_DEFAULT_MODEL:-$(_dci_litellm_model codex)}}";;
      nvidia)
        CODEX_API_KEY="${NVIDIA_API_KEY:-}"; CODEX_BASE_URL="https://integrate.api.nvidia.com/v1"; CODEX_MODEL="${MODEL:-${DEVLET_DEFAULT_MODEL:-nvidia/llama-3.1-nemotron-ultra-253b-v1}}";;
      *)
        if [ -n "$OPENAI_API_KEY" ]; then
          CODEX_API_KEY="$OPENAI_API_KEY"; CODEX_BASE_URL=""; CODEX_MODEL="${MODEL:-${DEVLET_DEFAULT_MODEL:-o4-mini}}"
        elif [ -n "$LITELLM_BASE_URL" ] && [ -n "$LITELLM_API_KEY" ]; then
          CODEX_API_KEY="$LITELLM_API_KEY"; CODEX_BASE_URL="${LITELLM_BASE_URL}/v1"; CODEX_MODEL="${MODEL:-${DEVLET_DEFAULT_MODEL:-$(_dci_litellm_model codex)}}"
        elif [ -n "$NVIDIA_API_KEY" ]; then
          CODEX_API_KEY="$NVIDIA_API_KEY"; CODEX_BASE_URL="https://integrate.api.nvidia.com/v1"; CODEX_MODEL="${MODEL:-${DEVLET_DEFAULT_MODEL:-nvidia/llama-3.1-nemotron-ultra-253b-v1}}"
        fi;;
    esac
    # Overwrite config with the exact requested model (devlet-coding-init wrote auto-detected defaults)
    mkdir -p ~/.codex
    _codex_kind=""; case "$CODEX_BASE_URL" in "${LITELLM_BASE_URL:-@}"/v1) _codex_kind=litellm;; esac
    _dci_codex_config "${CODEX_MODEL:-o4-mini}" "${CODEX_BASE_URL:-}" "$_codex_kind" > ~/.codex/config.toml
    ;;
  opencode)
    if [ -n "$PROVIDER" ]; then RESOLVED_PROVIDER="$PROVIDER"
    elif [ -n "$LITELLM_BASE_URL" ] && [ -n "$LITELLM_API_KEY" ]; then RESOLVED_PROVIDER="litellm"
    elif [ -n "$OPENROUTER_API_KEY" ]; then RESOLVED_PROVIDER="openrouter"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then RESOLVED_PROVIDER="anthropic"
    elif [ -n "$OPENAI_API_KEY" ]; then RESOLVED_PROVIDER="openai"
    elif [ -n "$GEMINI_API_KEY" ]; then RESOLVED_PROVIDER="gemini"
    elif [ -n "$NVIDIA_API_KEY" ]; then RESOLVED_PROVIDER="nvidia"
    else RESOLVED_PROVIDER="anthropic"; fi
    case "$RESOLVED_PROVIDER" in
      litellm)  OPENCODE_MODEL="litellm/${MODEL:-${DEVLET_DEFAULT_MODEL:-$(_dci_litellm_model opencode)}}"; [ "$OPENCODE_MODEL" = "litellm/" ] && OPENCODE_MODEL="litellm/gpt-4o";;
      openrouter) OPENCODE_MODEL="openrouter/${MODEL:-anthropic/claude-sonnet-4-6}";;
      anthropic)  OPENCODE_MODEL="anthropic/${MODEL:-claude-sonnet-4-5}";;
      openai)     OPENCODE_MODEL="openai/${MODEL:-gpt-4o}";;
      gemini)     OPENCODE_MODEL="google/${MODEL:-gemini-2.0-flash}";;
      nvidia)     OPENCODE_MODEL="nvidia/${MODEL:-${DEVLET_DEFAULT_MODEL:-nvidia/llama-3.1-nemotron-ultra-253b-v1}}";;
      *)          OPENCODE_MODEL="${RESOLVED_PROVIDER}/${MODEL:-}";;
    esac
    echo "[devlet] opencode provider=$RESOLVED_PROVIDER model=$OPENCODE_MODEL"
    ;;
esac

# ─── Execution ────────────────────────────────────────────────────────────────

case "$AGENT_TYPE" in
  claude-code)
    if [ -n "$MISSION" ]; then
      execute_mission claude --dangerously-skip-permissions -p "$MISSION"
      keep_alive_if_persistent
    elif [ "$PERSISTENT" = "true" ]; then
      exec tail -f /dev/null
    else
      exec claude
    fi
    ;;

  codex)
    if [ -z "$CODEX_MODEL" ]; then
      echo "[devlet] WARNING: no model configured for codex — set one with: devlet models set-default <provider> <model>"
    fi
    echo "[devlet] codex model=$CODEX_MODEL base_url=${CODEX_BASE_URL:-https://api.openai.com/v1}"

    CODEX_CONF=(-c "model=\"${CODEX_MODEL}\"")
    # config.toml (written above) already routes LiteLLM through its own provider
    [ -n "$CODEX_BASE_URL" ] && [ -z "$_codex_kind" ] && CODEX_CONF+=(-c "openai_base_url=\"${CODEX_BASE_URL}\"")

    if [ -n "$MISSION" ]; then
      execute_mission codex exec "${CODEX_CONF[@]}" --dangerously-bypass-approvals-and-sandbox "$MISSION"
      keep_alive_if_persistent
    elif [ "$PERSISTENT" = "true" ]; then
      exec tail -f /dev/null
    else
      exec codex "${CODEX_CONF[@]}"
    fi
    ;;

  opencode)
    if [ -n "$MISSION" ]; then
      execute_mission opencode run --model "$OPENCODE_MODEL" --dangerously-skip-permissions "$MISSION"
      keep_alive_if_persistent
    elif [ "$PERSISTENT" = "true" ]; then
      exec tail -f /dev/null
    else
      exec opencode --model "$OPENCODE_MODEL"
    fi
    ;;

  pi)
    if [ -n "$MISSION" ]; then
      execute_mission pi -p "$MISSION"
      keep_alive_if_persistent
    elif [ "$PERSISTENT" = "true" ]; then
      exec tail -f /dev/null
    else
      exec pi
    fi
    ;;

  gemini)
    if [ -n "$MISSION" ]; then
      execute_mission gemini --yolo -p "$MISSION"
      keep_alive_if_persistent
    elif [ "$PERSISTENT" = "true" ]; then
      exec tail -f /dev/null
    else
      exec gemini
    fi
    ;;

  *)
    echo "[devlet] ERROR: Unknown DEVLET_AGENT_TYPE='$AGENT_TYPE'"
    echo "[devlet] Valid values: claude-code | codex | opencode | pi | gemini"
    exit 1
    ;;
esac
