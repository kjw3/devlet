#!/bin/bash
# devlet/agent-base entrypoint
# Dispatches to the agent selected by DEVLET_AGENT_TYPE.
set -e

# Start web terminal background daemon (port/token injected at hire time)
. /usr/local/bin/devlet-terminal

AGENT_TYPE="${DEVLET_AGENT_TYPE:-claude-code}"
MISSION="${DEVLET_AGENT_MISSION:-}"
PERSISTENT="${DEVLET_AGENT_PERSISTENT:-false}"
PROVIDER="${DEVLET_AGENT_PROVIDER:-}"  # empty = auto-detect
MODEL="${DEVLET_AGENT_MODEL:-}"

# Set provider-specific model env vars from DEVLET_AGENT_MODEL if provided.
# Default to anthropic when no provider is set (preserves claude-code behaviour).
if [ -n "$MODEL" ]; then
  case "${PROVIDER:-anthropic}" in
    anthropic) export ANTHROPIC_MODEL="$MODEL" ;;
    openai)    export OPENAI_MODEL="$MODEL" ;;
    litellm)   export LITELLM_MODEL="$MODEL" ;;
  esac
fi

echo "[devlet] agent-type=$AGENT_TYPE provider=$PROVIDER persistent=$PERSISTENT mission=${MISSION:+(set)}"

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

case "$AGENT_TYPE" in
  claude-code)
    if [ -n "$MISSION" ]; then
      claude --dangerously-skip-permissions -p "$MISSION"
      keep_alive_if_persistent
    elif [ "$PERSISTENT" = "true" ]; then
      exec tail -f /dev/null
    else
      exec claude
    fi
    ;;

  codex)
    # Provider selection: explicit DEVLET_AGENT_PROVIDER > auto-detect (OpenAI → LiteLLM → NVIDIA).
    # Codex does NOT read OPENAI_BASE_URL from the environment; the base URL must
    # be passed via the -c openai_base_url="..." config flag on every invocation.
    # Codex also uses its own credential store, so pipe the key into codex login.
    case "$PROVIDER" in
      openai)
        CODEX_API_KEY="${OPENAI_API_KEY:-}"
        CODEX_BASE_URL=""
        CODEX_MODEL="${MODEL:-${DEVLET_DEFAULT_MODEL:-o4-mini}}"
        ;;
      litellm)
        CODEX_API_KEY="${LITELLM_API_KEY:-}"
        CODEX_BASE_URL="${LITELLM_BASE_URL}/v1"
        CODEX_MODEL="${MODEL:-${DEVLET_DEFAULT_MODEL:-}}"
        ;;
      nvidia)
        CODEX_API_KEY="${NVIDIA_API_KEY:-}"
        CODEX_BASE_URL="https://integrate.api.nvidia.com/v1"
        CODEX_MODEL="${MODEL:-${DEVLET_DEFAULT_MODEL:-nvidia/llama-3.1-nemotron-ultra-253b-v1}}"
        ;;
      *)
        # Auto-detect: OpenAI → LiteLLM → NVIDIA
        if [ -n "$OPENAI_API_KEY" ]; then
          CODEX_API_KEY="$OPENAI_API_KEY"
          CODEX_BASE_URL=""
          CODEX_MODEL="${MODEL:-${DEVLET_DEFAULT_MODEL:-o4-mini}}"
        elif [ -n "$LITELLM_BASE_URL" ] && [ -n "$LITELLM_API_KEY" ]; then
          CODEX_API_KEY="$LITELLM_API_KEY"
          CODEX_BASE_URL="${LITELLM_BASE_URL}/v1"
          CODEX_MODEL="${MODEL:-${DEVLET_DEFAULT_MODEL:-}}"
        elif [ -n "$NVIDIA_API_KEY" ]; then
          CODEX_API_KEY="$NVIDIA_API_KEY"
          CODEX_BASE_URL="https://integrate.api.nvidia.com/v1"
          CODEX_MODEL="${MODEL:-${DEVLET_DEFAULT_MODEL:-nvidia/llama-3.1-nemotron-ultra-253b-v1}}"
        fi
        ;;
    esac

    if [ -z "$CODEX_MODEL" ]; then
      echo "[devlet] WARNING: no model configured for codex — set one with: devlet models set-default <provider> <model>"
    fi
    echo "[devlet] codex model=$CODEX_MODEL base_url=${CODEX_BASE_URL:-https://api.openai.com/v1}"

    if [ -n "$CODEX_API_KEY" ]; then
      echo "$CODEX_API_KEY" | codex login --with-api-key
    fi

    # Build config args; always pin model, add base URL only for non-OpenAI providers
    CODEX_CONF=(-c "model=\"${CODEX_MODEL}\"")
    if [ -n "$CODEX_BASE_URL" ]; then
      CODEX_CONF+=(-c "openai_base_url=\"${CODEX_BASE_URL}\"")
    fi

    if [ -n "$MISSION" ]; then
      codex exec "${CODEX_CONF[@]}" --dangerously-bypass-approvals-and-sandbox "$MISSION"
      keep_alive_if_persistent
    elif [ "$PERSISTENT" = "true" ]; then
      exec tail -f /dev/null
    else
      exec codex "${CODEX_CONF[@]}"
    fi
    ;;

  opencode)
    # Step 1 — resolve provider: explicit DEVLET_AGENT_PROVIDER > auto-detect.
    # Priority: LiteLLM → OpenRouter → Anthropic → OpenAI → Gemini → NVIDIA.
    if [ -n "$PROVIDER" ]; then
      RESOLVED_PROVIDER="$PROVIDER"
    elif [ -n "$LITELLM_BASE_URL" ] && [ -n "$LITELLM_API_KEY" ]; then
      RESOLVED_PROVIDER="litellm"
    elif [ -n "$OPENROUTER_API_KEY" ]; then
      RESOLVED_PROVIDER="openrouter"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
      RESOLVED_PROVIDER="anthropic"
    elif [ -n "$OPENAI_API_KEY" ]; then
      RESOLVED_PROVIDER="openai"
    elif [ -n "$GEMINI_API_KEY" ]; then
      RESOLVED_PROVIDER="gemini"
    elif [ -n "$NVIDIA_API_KEY" ]; then
      RESOLVED_PROVIDER="nvidia"
    else
      RESOLVED_PROVIDER="anthropic"
    fi

    # Step 2 — build the OpenCode model string for the resolved provider.
    # For LiteLLM and NVIDIA, register a custom OpenAI-compatible provider via
    # ~/.config/opencode/config.json so arbitrary model IDs bypass the built-in
    # model registry validation.
    case "$RESOLVED_PROVIDER" in
      litellm)
        _oc_model="${MODEL:-${DEVLET_DEFAULT_MODEL:-}}"
        if [ -z "$_oc_model" ]; then
          echo "[devlet] WARNING: no LiteLLM model set — use: devlet models set-default litellm <model>"
          _oc_model="gpt-4o"
        fi
        mkdir -p "${HOME}/.config/opencode"
        printf '{"provider":{"litellm":{"npm":"@ai-sdk/openai-compatible","name":"LiteLLM","options":{"baseURL":"%s/v1","apiKey":"{env:LITELLM_API_KEY}"},"models":{"%s":{"name":"%s"}}}}}' \
          "$LITELLM_BASE_URL" "$_oc_model" "$_oc_model" > "${HOME}/.config/opencode/config.json"
        OPENCODE_MODEL="litellm/${_oc_model}"
        ;;
      openrouter)
        OPENCODE_MODEL="openrouter/${MODEL:-anthropic/claude-sonnet-4.6}"
        ;;
      anthropic)
        OPENCODE_MODEL="anthropic/${MODEL:-claude-sonnet-4-5}"
        ;;
      openai)
        OPENCODE_MODEL="openai/${MODEL:-gpt-4o}"
        ;;
      gemini)
        OPENCODE_MODEL="google/${MODEL:-gemini-2.0-flash}"
        ;;
      nvidia)
        _oc_model="${MODEL:-${DEVLET_DEFAULT_MODEL:-nvidia/llama-3.1-nemotron-ultra-253b-v1}}"
        mkdir -p "${HOME}/.config/opencode"
        printf '{"provider":{"nvidia":{"npm":"@ai-sdk/openai-compatible","name":"NVIDIA","options":{"baseURL":"https://integrate.api.nvidia.com/v1","apiKey":"{env:NVIDIA_API_KEY}"},"models":{"%s":{"name":"%s"}}}}}' \
          "$_oc_model" "$_oc_model" > "${HOME}/.config/opencode/config.json"
        OPENCODE_MODEL="nvidia/${_oc_model}"
        ;;
      *)
        OPENCODE_MODEL="${RESOLVED_PROVIDER}/${MODEL:-}"
        ;;
    esac
    echo "[devlet] opencode provider=$RESOLVED_PROVIDER model=$OPENCODE_MODEL"
    if [ -n "$MISSION" ]; then
      opencode run --model "$OPENCODE_MODEL" --dangerously-skip-permissions "$MISSION"
      keep_alive_if_persistent
    elif [ "$PERSISTENT" = "true" ]; then
      exec tail -f /dev/null
    else
      exec opencode --model "$OPENCODE_MODEL"
    fi
    ;;

  pi)
    if [ -n "$MISSION" ]; then
      pi -p "$MISSION"
      keep_alive_if_persistent
    elif [ "$PERSISTENT" = "true" ]; then
      exec tail -f /dev/null
    else
      exec pi
    fi
    ;;

  gemini)
    # Gemini CLI reads GEMINI_API_KEY directly; some versions also look for
    # GOOGLE_GENERATIVE_AI_API_KEY — export both to cover all releases.
    if [ -n "$GEMINI_API_KEY" ]; then
      export GOOGLE_GENERATIVE_AI_API_KEY="$GEMINI_API_KEY"
    fi
    if [ -n "$MISSION" ]; then
      gemini --yolo -p "$MISSION"
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
