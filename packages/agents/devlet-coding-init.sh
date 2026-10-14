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

# ─── LiteLLM gateway detection ───────────────────────────────────────────────
# LiteLLM exposes Anthropic (/v1/messages), OpenAI (/v1/*) and Gemini (/gemini)
# compatible endpoints, so one LITELLM_* pair can serve every coding CLI.
# A tool uses it when explicitly selected (DEVLET_AGENT_PROVIDER=litellm) or,
# with no provider selected, when its native provider key is missing.
_dci_litellm=false
[ -n "${LITELLM_BASE_URL:-}" ] && [ -n "${LITELLM_API_KEY:-}" ] && _dci_litellm=true
_dci_litellm_base="${LITELLM_BASE_URL%/}"

# Model for a tool when LiteLLM is the provider. An explicit model
# (DEVLET_AGENT_MODEL, then DEVLET_DEFAULT_MODEL) always wins; otherwise pick the
# best fit for the tool from the models the proxy actually serves (/v1/models).
# LiteLLM has no default model of its own, so without this a CLI would ask for
# names the proxy may not have.
_dci_models=""
if $_dci_litellm && [ -z "${DEVLET_AGENT_MODEL:-}${DEVLET_DEFAULT_MODEL:-}${LITELLM_MODEL:-}" ]; then
  _dci_models=$(curl -fsS --connect-timeout 3 -m 6 \
    -H "Authorization: Bearer $LITELLM_API_KEY" "${_dci_litellm_base}/v1/models" 2>/dev/null \
    | python3 -c 'import sys,json; [print(m["id"]) for m in json.load(sys.stdin).get("data",[]) if m.get("id")]' 2>/dev/null) || _dci_models=""
fi

_dci_litellm_model() {  # $1 = tool name; prints a model id (maybe empty)
  if [ -n "${DEVLET_AGENT_MODEL:-}" ]; then printf '%s' "$DEVLET_AGENT_MODEL"; return; fi
  if [ -n "${DEVLET_DEFAULT_MODEL:-}" ]; then printf '%s' "$DEVLET_DEFAULT_MODEL"; return; fi
  if [ -n "${LITELLM_MODEL:-}" ]; then printf '%s' "$LITELLM_MODEL"; return; fi
  [ -n "$_dci_models" ] || return 0
  printf '%s\n' "$_dci_models" | python3 -c '
import sys, re
tool = sys.argv[1]
ids = [l.strip() for l in sys.stdin if l.strip()]
skip = re.compile(r"embed|whisper|tts|dall-e|image|moderation|rerank|transcri|speech|audio|realtime|sora|imagen", re.I)
ids = [i for i in ids if not skip.search(i)]
prefs = {
    "claude-code": [r"sonnet", r"opus", r"claude|anthropic"],
    "codex":       [r"gpt-5.*codex", r"gpt-5", r"gpt-4\.1", r"(^|/)o[134]", r"gpt-4o", r"gpt"],
    "gemini":      [r"gemini.*pro", r"gemini.*flash", r"gemini"],
}
generic = [r"sonnet", r"gpt-5", r"gpt-4", r"gemini.*pro", r"opus", r"claude", r"gemini", r"gpt"]
small = re.compile(r"mini|nano|lite|haiku|preview|flash-8b", re.I)
def key(i):  # prefer full-size models, then the highest version number
    return (bool(small.search(i)), tuple(-int(n) for n in re.findall(r"\d+", i)), i)
for pat in prefs.get(tool, generic):
    hits = sorted((i for i in ids if re.search(pat, i, re.I)), key=key)
    if hits:
        print(hits[0]); break
else:
    if ids: print(ids[0])
' "$1" 2>/dev/null
}

# Context limits for a LiteLLM model, read from the gateway's model-group info
# (needs the key to be allowed info_routes). Prints "<max_input> <max_output>" with either
# part empty when unknown; prints nothing when the lookup is denied or fails.
# Claude Code assumes 200k for model names it doesn't recognise, so real limits matter.
_dci_litellm_limits() {  # $1 = model id
  [ -n "$1" ] || return 0
  curl -fsS --connect-timeout 3 -m 6 -H "Authorization: Bearer $LITELLM_API_KEY" \
    "${_dci_litellm_base}/model_group/info" 2>/dev/null \
    | python3 -c '
import sys, json
want = sys.argv[1]
try:
    rows = json.load(sys.stdin).get("data", [])
except Exception:
    sys.exit(0)
for m in rows:
    if m.get("model_group") == want:
        i, o = m.get("max_input_tokens"), m.get("max_output_tokens")
        print(int(i) if i else "", int(o) if o else "")
        break
' "$1" 2>/dev/null
}

# Per-tool wrappers: LiteLLM settings are applied by a small launcher placed ahead
# of the real CLI on PATH, NOT exported globally. Global exports leak across tools
# (e.g. a LiteLLM key in GEMINI_API_KEY makes Pi choose Google and send it there).
_dci_bin="$HOME/.devlet/bin"
_dci_wrap() {  # $1 tool, $2 env-assignment lines, $3 extra leading args (optional)
  local real
  real=$(PATH="${PATH//$_dci_bin:/}" command -v "$1") || return 0
  mkdir -p "$_dci_bin"
  printf '#!/bin/sh\n%s\nexec %q %s "$@"\n' "$2" "$real" "${3:-}" > "$_dci_bin/$1"
  chmod 700 "$_dci_bin/$1"
  case ":$PATH:" in *":$_dci_bin:"*) ;; *) export PATH="$_dci_bin:$PATH" ;; esac
}
_dci_kv() { printf 'export %s=%q\n' "$1" "$2"; }  # env line for a wrapper

# ─── Claude Code ─────────────────────────────────────────────────────────────
if command -v claude &>/dev/null; then
  mkdir -p ~/.claude
  [ -f ~/.claude/settings.json ] || \
    printf '{"theme":"dark","hasCompletedOnboarding":true}\n' > ~/.claude/settings.json
  if $_dci_litellm && { [ "${DEVLET_AGENT_PROVIDER:-}" = "litellm" ] || \
      { [ -z "${DEVLET_AGENT_PROVIDER:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; }; }; then
    _dci_gmodel=$(_dci_litellm_model claude-code)
    _dci_env="$(_dci_kv ANTHROPIC_BASE_URL "$_dci_litellm_base")
$(_dci_kv ANTHROPIC_AUTH_TOKEN "$LITELLM_API_KEY")
unset ANTHROPIC_API_KEY"
    if [ -n "$_dci_gmodel" ]; then
      # Claude Code also calls Opus/Sonnet/Haiku aliases internally; point them
      # all at the one model the gateway serves.
      for _dci_v in ANTHROPIC_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL \
                    ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_SMALL_FAST_MODEL; do
        _dci_env="$_dci_env
$(_dci_kv "$_dci_v" "$_dci_gmodel")"
      done
    fi
    # Tell Claude Code the model's real window (it can't know for gateway aliases).
    # Precedence: LITELLM_CONTEXT_TOKENS override, then the gateway's reported limits.
    if [ -n "$_dci_gmodel" ]; then
      _dci_limits=$(_dci_litellm_limits "$_dci_gmodel")
      _dci_ctx="${_dci_limits%% *}"; _dci_out="${_dci_limits##* }"
      [ -n "${LITELLM_CONTEXT_TOKENS:-}" ] && _dci_ctx="$LITELLM_CONTEXT_TOKENS"
      [ -n "$_dci_ctx" ] && _dci_env="$_dci_env
$(_dci_kv CLAUDE_CODE_MAX_CONTEXT_TOKENS "$_dci_ctx")"
      [ -n "$_dci_out" ] && _dci_env="$_dci_env
$(_dci_kv CLAUDE_CODE_MAX_OUTPUT_TOKENS "$_dci_out")"
    fi
    _dci_wrap claude "$_dci_env"
    echo "[devlet] litellm: claude model=${_dci_gmodel:-<claude default>} context=${_dci_ctx:-default} max_output=${_dci_out:-default}"
  fi
fi

# ─── Gemini CLI ──────────────────────────────────────────────────────────────
if $_dci_litellm && command -v gemini &>/dev/null && \
   { [ "${DEVLET_AGENT_PROVIDER:-}" = "litellm" ] || \
     { [ -z "${DEVLET_AGENT_PROVIDER:-}" ] && [ -z "${GEMINI_API_KEY:-}" ]; }; }; then
  _dci_gmodel=$(_dci_litellm_model gemini)
  _dci_env="$(_dci_kv GOOGLE_GEMINI_BASE_URL "${_dci_litellm_base}/gemini")
$(_dci_kv GEMINI_API_KEY "$LITELLM_API_KEY")
$(_dci_kv GOOGLE_GENERATIVE_AI_API_KEY "$LITELLM_API_KEY")"
  [ -n "$_dci_gmodel" ] && _dci_env="$_dci_env
$(_dci_kv GEMINI_MODEL "$_dci_gmodel")"
  # Headless gemini rejects the env-derived "gateway" auth type ("Invalid auth method
  # selected"), so pin the API-key type; it still honours GOOGLE_GEMINI_BASE_URL.
  mkdir -p ~/.gemini
  [ -f ~/.gemini/settings.json ] || \
    printf '{"security":{"auth":{"selectedType":"gemini-api-key"}}}\n' > ~/.gemini/settings.json
  _dci_wrap gemini "$_dci_env"
  echo "[devlet] litellm: gemini model=${_dci_gmodel:-<gemini default>}"
fi

# ─── Pi ──────────────────────────────────────────────────────────────────────
# Pi defaults to the "google" provider, so pin it to the litellm provider defined
# in models.json whenever LiteLLM is the gateway.
if $_dci_litellm && command -v pi &>/dev/null && \
   { [ "${DEVLET_AGENT_PROVIDER:-}" = "litellm" ] || \
     { [ -z "${DEVLET_AGENT_PROVIDER:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}" ]; }; }; then
  _dci_gmodel=$(_dci_litellm_model pi)
  if [ -n "$_dci_gmodel" ]; then
    mkdir -p ~/.pi/agent
    printf '{"providers":{"litellm":{"baseUrl":"%s/v1","api":"openai-completions","apiKey":"LITELLM_API_KEY","models":[{"id":"%s"}]}}}\n' \
      "$_dci_litellm_base" "$_dci_gmodel" > ~/.pi/agent/models.json
    _dci_wrap pi "$(_dci_kv LITELLM_API_KEY "$LITELLM_API_KEY")" "--provider litellm --model $(printf '%q' "$_dci_gmodel")"
    echo "[devlet] litellm: pi model=$_dci_gmodel"
  fi
fi
unset _dci_env _dci_v

# ~/.codex/config.toml body. $1 model, $2 base URL (empty = OpenAI), $3 "litellm" for the gateway.
# A gateway reached through a reverse proxy usually rejects Codex's default Responses
# WebSocket (403 on the upgrade, then 5 retries before the HTTPS fallback), so LiteLLM gets
# its own provider with WebSockets off. It reuses the login key (requires_openai_auth) so a
# terminal shell needs no extra env. The model's context window is passed along so Codex
# stops warning about missing model metadata.
_dci_codex_config() {
  printf 'model = "%s"\n' "${1:-o4-mini}"
  if [ "$3" = "litellm" ] && [ -n "$2" ]; then
    local lim ctx
    lim=$(_dci_litellm_limits "$1"); ctx="${lim%% *}"
    [ -n "$ctx" ] && printf 'model_context_window = %s\n' "$ctx"
    printf 'model_provider = "litellm"\n\n[model_providers.litellm]\nname = "LiteLLM"\nbase_url = "%s"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n' "$2"
  elif [ -n "$2" ]; then
    printf 'openai_base_url = "%s"\n' "$2"
  fi
}

# ─── Codex ───────────────────────────────────────────────────────────────────
if command -v codex &>/dev/null; then
  _dci_api_key="" _dci_base_url="" _dci_model="" _dci_kind=""
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    _dci_api_key="$OPENAI_API_KEY"
    _dci_model="${DEVLET_DEFAULT_MODEL:-o4-mini}"
  elif [ -n "${LITELLM_API_KEY:-}" ] && [ -n "${LITELLM_BASE_URL:-}" ]; then
    _dci_api_key="$LITELLM_API_KEY"
    _dci_base_url="${LITELLM_BASE_URL}/v1"; _dci_kind=litellm
    _dci_model=$(_dci_litellm_model codex)
  elif [ -n "${NVIDIA_API_KEY:-}" ]; then
    _dci_api_key="$NVIDIA_API_KEY"
    _dci_base_url="https://integrate.api.nvidia.com/v1"
    _dci_model="${DEVLET_DEFAULT_MODEL:-nvidia/llama-3.1-nemotron-ultra-253b-v1}"
  fi
  if [ -n "$_dci_api_key" ]; then
    echo "$_dci_api_key" | codex login --with-api-key 2>/dev/null || true
    # Codex reads ~/.codex/config.toml (not ~/.config/codex/*), so a bare `codex`
    # typed in the web terminal picks up the gateway as well as scripted runs.
    mkdir -p ~/.codex
    _dci_codex_config "$_dci_model" "$_dci_base_url" "$_dci_kind" > ~/.codex/config.toml
  fi
  unset _dci_api_key _dci_base_url _dci_model _dci_kind
fi

# ─── OpenCode ─────────────────────────────────────────────────────────────────
if command -v opencode &>/dev/null; then
  mkdir -p ~/.config/opencode
  if [ ! -f ~/.config/opencode/config.json ]; then
    if [ -n "${LITELLM_BASE_URL:-}" ] && [ -n "${LITELLM_API_KEY:-}" ]; then
      _dci_m=$(_dci_litellm_model opencode); _dci_m="${_dci_m:-gpt-4o}"
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

unset _dci_gmodel  # _dci_models + _dci_litellm_model stay for the entrypoint's exec phase

# ─── Web terminal / interactive shells ───────────────────────────────────────
# ttyd starts before this script and launches plain non-login `bash` sessions, so
# they inherit neither the PATH wrappers above nor anything exported here. Have
# interactive shells source the snapshot written below.
if ! grep -qF '.devlet-env' ~/.bashrc 2>/dev/null; then
  printf '\n[ -f ~/.devlet-env ] && . ~/.devlet-env\n' >> ~/.bashrc
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
