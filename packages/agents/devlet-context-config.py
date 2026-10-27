#!/usr/bin/env python3
"""Seed context defaults for LiteLLM harnesses; preserve explicit user settings.
Decent fallback metadata audited against the owner's Pi configuration 2026-10-27.
Gateway limits / LITELLM_CONTEXT_TOKENS take precedence over the fallback catalog.
"""
import json
import os
from pathlib import Path
import re
import sys
import tempfile


def policy(model, context="", output=""):
    known = model in {"decent-" + kind + suffix for kind in ("chat", "code") for suffix in ("", "-fast", "-large")}
    fallback = (32768, 4096, 16384, 4096) if model.endswith("-fast") else ((262144, 8192, 32768, 16384) if model.endswith("-large") else (65536, 8192, 16384, 8192))
    def positive(v, default):
        try:
            n = int(v)
            return n if n > 0 else default
        except (ValueError, TypeError):
            return default
    ctx = positive(context, fallback[0] if known else None)
    out = positive(output, fallback[1] if known else None)
    if not ctx or not out or out >= ctx:
        return None
    reserve = min(max(out * 2, fallback[2] if known else 16384), ctx // 2)
    return dict(context=ctx, output=out, reserve=reserve, recent=min(fallback[3], (ctx-reserve)//2), known=known)


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(data)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def load(path):
    return json.loads(path.read_text()) if path.exists() else {}


def configure(home, harness, model, context="", output=""):
    p = policy(model, context, output)
    if p is None and harness != "pi":
        print(f"[devlet] context: {harness} model limits unknown; defaults unchanged", file=sys.stderr)
        return
    if harness == "pi":
        path = home / ".pi/agent/models.json"
        data = load(path)
        provider = data.setdefault("providers", {}).setdefault("litellm", {})
        provider.setdefault("baseUrl", os.environ.get("LITELLM_BASE_URL", "").rstrip("/") + "/v1")
        provider.setdefault("api", "openai-completions")
        provider.setdefault("apiKey", "$LITELLM_API_KEY")
        models = provider.setdefault("models", [])
        selected = next((m for m in models if m.get("id") == model), None)
        if selected is None:
            selected = {"id": model}
            models.append(selected)
        if p:
            for key, value in {"contextWindow": p["context"], "maxTokens": p["output"]}.items(): selected.setdefault(key, value)
        if p and p["known"]:
            selected.setdefault("reasoning", True)
            selected.setdefault("input", ["text", "image"])
            selected.setdefault("compat", {}).update({k:v for k,v in {"maxTokensField":"max_tokens", "supportsReasoningEffort":True, "thinkingFormat":"openai"}.items() if k not in selected.get("compat", {})})
            selected.setdefault("thinkingLevelMap", {"off":"none", "minimal":None, "low":None if model.endswith("-fast") else "low", "medium":None if model.endswith("-fast") else "medium", "high":"high", "xhigh":None, "max":None})
        write(path, json.dumps(data, indent=2)+"\n")
        if p is None:
            print("[devlet] context: Pi model limits unknown; provider configured without guessed limits", file=sys.stderr)
            return
        path = home / ".pi/agent/settings.json"
        data = load(path)
        if p["known"]: data.setdefault("defaultThinkingLevel", "off")
        comp = data.setdefault("compaction", {})
        comp.setdefault("enabled", True)
        override = comp.setdefault("modelOverrides", {}).setdefault("litellm/"+model, {})
        override.setdefault("reserveTokens", p["reserve"])
        override.setdefault("keepRecentTokens", p["recent"])
        write(path, json.dumps(data, indent=2)+"\n")
    elif harness == "codex":
        path = home / ".codex/config.toml"
        text = path.read_text() if path.exists() else ""
        additions = {"model_context_window":p["context"], "model_auto_compact_token_limit":p["context"]-p["reserve"]}
        prefix = text.split("[",1)[0]
        for key, value in additions.items():
            if not re.search(r"^\s*"+key+r"\s*=", prefix, re.M): text = f"{key} = {value}\n"+text
        write(path, text)
    elif harness == "opencode":
        path = home / ".config/opencode/config.json"
        data = load(path)
        selected = data.get("model", "")
        if selected != "litellm/"+model: return
        comp = data.setdefault("compaction", {})
        for key, value in {"auto":True, "prune":True, "reserved":p["reserve"]}.items(): comp.setdefault(key,value)
        limit = data.setdefault("provider", {}).setdefault("litellm", {}).setdefault("models", {}).setdefault(model, {}).setdefault("limit", {})
        limit.setdefault("context", p["context"])
        limit.setdefault("output", p["output"])
        write(path, json.dumps(data, indent=2)+"\n")
    elif harness == "gemini":
        path = home / ".gemini/settings.json"
        data = load(path)
        # Gemini CLI 0.64 tokenLimit() uses 1,048,576 for unknown aliases.
        # Scale its compression fraction to the real alias window rather than 1M.
        data.setdefault("model", {}).setdefault("compressionThreshold", min(0.5, (p["context"]-p["reserve"])/1048576))
        configs = data.setdefault("modelConfigs", {})
        configs.setdefault("customAliases", {}).setdefault("chat-compression-default", {"modelConfig":{"model":model,"generateContentConfig":{"maxOutputTokens":p["output"]}}})
        overrides = configs.setdefault("customOverrides", [])
        if not any(item.get("match", {}).get("model") == model for item in overrides):
            overrides.append({"match":{"model":model}, "modelConfig":{"generateContentConfig":{"maxOutputTokens":p["output"]}}})
        write(path, json.dumps(data, indent=2)+"\n")
    elif harness == "claude-code":
        # Wrapper-only env avoids changing native-provider behavior or leaking settings.
        path = home / ".devlet/bin/claude"
        if not path.exists(): return
        text = path.read_text()
        # Existing environment overrides remain authoritative.
        line = ': "${CLAUDE_CODE_MAX_CONTEXT_TOKENS:=' + str(p["context"]) + '}"\nexport CLAUDE_CODE_MAX_CONTEXT_TOKENS\n: "${CLAUDE_CODE_MAX_OUTPUT_TOKENS:=' + str(p["output"]) + '}"\nexport CLAUDE_CODE_MAX_OUTPUT_TOKENS\n: "${CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:=' + str(max(1, int(100*(p["context"]-p["reserve"])/p["context"]))) + '}"\nexport CLAUDE_AUTOCOMPACT_PCT_OVERRIDE\n'
        if "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE" not in text: text = text.replace("exec ", line+"exec ",1)
        write(path, text)
        path.chmod(0o700)


if __name__ == "__main__":
    configure(Path.home(), *sys.argv[1:])
