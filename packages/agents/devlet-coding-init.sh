#!/bin/bash
# devlet-coding-init — pre-configure all base coding tools.
# Sourced by ALL devlet agent entrypoints (base, openclaw, moltis, hermes, …)
# so that coding CLIs are ready to use regardless of which agent type is
# primary.  Uses auto-detection from available env keys so it works for both
# the primary base agent and secondary tools on gateway agents.
#
# Must not call exec or exit — runs inside the caller's shell.

# ─── Global env aliases ───────────────────────────────────────────────────────
[ -n "$GEMINI_API_KEY" ] && [ -z "$GOOGLE_GENERATIVE_AI_API_KEY" ] && \
  export GOOGLE_GENERATIVE_AI_API_KEY="$GEMINI_API_KEY"

# ─── Claude Code ─────────────────────────────────────────────────────────────
if command -v claude &>/dev/null; then
  mkdir -p ~/.claude
  [ -f ~/.claude/settings.json ] || \
    printf '{"theme":"dark","hasCompletedOnboarding":true}\n' > ~/.claude/settings.json
fi

# ─── Codex ───────────────────────────────────────────────────────────────────
if command -v codex &>/dev/null; then
  _dci_api_key="" _dci_base_url="" _dci_model=""
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    _dci_api_key="$OPENAI_API_KEY"
    _dci_model="${DEVLET_DEFAULT_MODEL:-o4-mini}"
  elif [ -n "${LITELLM_API_KEY:-}" ] && [ -n "${LITELLM_BASE_URL:-}" ]; then
    _dci_api_key="$LITELLM_API_KEY"
    _dci_base_url="${LITELLM_BASE_URL}/v1"
    _dci_model="${DEVLET_DEFAULT_MODEL:-}"
  elif [ -n "${NVIDIA_API_KEY:-}" ]; then
    _dci_api_key="$NVIDIA_API_KEY"
    _dci_base_url="https://integrate.api.nvidia.com/v1"
    _dci_model="${DEVLET_DEFAULT_MODEL:-nvidia/llama-3.1-nemotron-ultra-253b-v1}"
  fi
  if [ -n "$_dci_api_key" ]; then
    echo "$_dci_api_key" | codex login --with-api-key 2>/dev/null || true
    mkdir -p ~/.config/codex
    if [ -n "$_dci_base_url" ]; then
      printf '{"model":"%s","openai_base_url":"%s"}\n' \
        "${_dci_model:-o4-mini}" "$_dci_base_url" > ~/.config/codex/config.json
    else
      printf '{"model":"%s"}\n' "${_dci_model:-o4-mini}" > ~/.config/codex/config.json
    fi
  fi
  unset _dci_api_key _dci_base_url _dci_model
fi

# ─── OpenCode ─────────────────────────────────────────────────────────────────
if command -v opencode &>/dev/null; then
  mkdir -p ~/.config/opencode
  if [ ! -f ~/.config/opencode/config.json ]; then
    if [ -n "${LITELLM_BASE_URL:-}" ] && [ -n "${LITELLM_API_KEY:-}" ]; then
      _dci_m="${DEVLET_DEFAULT_MODEL:-gpt-4o}"
      printf '{"model":"litellm/%s","provider":{"litellm":{"npm":"@ai-sdk/openai-compatible","name":"LiteLLM","options":{"baseURL":"%s/v1","apiKey":"{env:LITELLM_API_KEY}"},"models":{"%s":{"name":"%s"}}}}}' \
        "$_dci_m" "$LITELLM_BASE_URL" "$_dci_m" "$_dci_m" > ~/.config/opencode/config.json
      unset _dci_m
    elif [ -n "${OPENROUTER_API_KEY:-}" ]; then
      printf '{"model":"openrouter/anthropic/claude-sonnet-4-6"}\n' > ~/.config/opencode/config.json
    elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
      printf '{"model":"anthropic/claude-sonnet-4-5"}\n' > ~/.config/opencode/config.json
    elif [ -n "${OPENAI_API_KEY:-}" ]; then
      printf '{"model":"openai/gpt-4o"}\n' > ~/.config/opencode/config.json
    elif [ -n "${GEMINI_API_KEY:-}" ]; then
      printf '{"model":"google/gemini-2.0-flash"}\n' > ~/.config/opencode/config.json
    elif [ -n "${NVIDIA_API_KEY:-}" ]; then
      _dci_m="${DEVLET_DEFAULT_MODEL:-nvidia/llama-3.1-nemotron-ultra-253b-v1}"
      printf '{"model":"nvidia/%s","provider":{"nvidia":{"npm":"@ai-sdk/openai-compatible","name":"NVIDIA","options":{"baseURL":"https://integrate.api.nvidia.com/v1","apiKey":"{env:NVIDIA_API_KEY}"},"models":{"%s":{"name":"%s"}}}}}' \
        "$_dci_m" "$_dci_m" "$_dci_m" > ~/.config/opencode/config.json
      unset _dci_m
    fi
  fi
fi

# ─── Refresh SSH session env snapshot ────────────────────────────────────────
# Writes ~/.devlet-env so SSH login shells inherit all credentials and aliases.
# devlet-ssh already added the sourcing hook to ~/.profile.
python3 -c "
import os, shlex
skip = {'SHLVL','PWD','OLDPWD','_','TERM','COLORTERM','LS_COLORS','DISPLAY'}
try:
    with open(os.path.expanduser('~/.devlet-env'), 'w') as f:
        for k in sorted(os.environ):
            if k in skip or k.startswith('BASH') or k.startswith('_ds_') \
               or k.startswith('_dt_') or k.startswith('_dci_'):
                continue
            f.write('export {}={}\n'.format(k, shlex.quote(os.environ[k])))
except Exception:
    pass
" 2>/dev/null || true
