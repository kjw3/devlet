/**
 * hermes-config.mjs — Safe Hermes configuration management for Devlet agents.
 *
 * Merge policy (highest priority wins):
 *   1. Explicit Devlet-managed provider/model overrides (from env vars)
 *   2. Existing agent settings in config.yaml (preserved on restart)
 *   3. Versioned baseline defaults (pinned to the Hermes release in the image)
 *
 * Safety guarantees:
 *   - Never overwrites a valid existing config.yaml when parsing fails.
 *   - Atomic writes (write to temp file, then rename).
 *   - File permissions are 0600 on both config.yaml and .env.
 *   - .env: existing entries are always preserved; only managed keys are added/updated.
 *   - Credentials are never logged.
 *
 * Run as a script (from the entrypoint):
 *   node /usr/local/lib/hermes-config.mjs
 *
 * Or import the exported functions for testing.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

// ─── Versioned baseline ─────────────────────────────────────────────────────
// Pinned to Hermes v2026.9.24 (the version in Dockerfile.hermes).
// These are conservative starting values, not benchmarked optimal settings.
// Bump HERMES_BASELINE_VERSION when the Hermes image version changes.
const HERMES_BASELINE_VERSION = "v2026.9.24";

/**
 * Returns the baseline defaults merged into an empty config.
 * The model section is NOT part of the baseline — it is always an explicit
 * override from env vars. This way, provider changes only touch the model
 * block and all other settings (compression, memory, tools, etc.) survive.
 */
export function buildBaseline() {
  return {
    _devlet: {
      baseline_version: HERMES_BASELINE_VERSION,
      managed: true,
    },
    terminal: {
      backend: "local",
      cwd: "/workspace",
      home_mode: "real",
    },
    agent: {
      max_turns: 100,
    },
    delegation: {
      max_iterations: 50,
    },
    compression: {
      enabled: true,
    },
    auxiliary: {
      compression: {
        timeout: 120,
      },
      title_generation: {
        model_upgrade_enabled: false,
      },
    },
  };
}

// ─── Provider mapping ───────────────────────────────────────────────────────
// Maps Devlet provider names to Hermes provider identifiers.
//
// Corrections from the 2026-10-18 configuration review:
//   - `openai` without a custom URL maps to `openai` (API-key auth),
//     NOT `openai-codex` (which is an OAuth subscription provider).
//   - `gemini` is now supported (maps to `google` in Hermes).
//   - `litellm` remains `custom` (OpenAI-compatible proxy endpoint).
const PROVIDER_MAP = {
  litellm: "custom",
  anthropic: "anthropic",
  openai: "openai", // API-key auth (NOT openai-codex OAuth)
  openrouter: "openrouter",
  gemini: "google",
  nvidia: "custom",
  groq: "custom",
};

/**
 * Resolves a Devlet provider+model to the Hermes config model block.
 * Returns { provider, default, base_url?, api_key? }.
 *
 * @param {string} devletProvider - DEVLET_AGENT_PROVIDER value
 * @param {string} model - DEVLET_AGENT_MODEL value (may be empty)
 * @param {object} env - environment variables (process.env or equivalent)
 * @param {string} [litellmModel] - pre-resolved LiteLLM model (from _dci_litellm_model)
 */
export function resolveModelConfig(devletProvider, model, env, litellmModel = "") {
  const provider = (devletProvider || "").trim().toLowerCase();
  const base = { provider: "", default: "", base_url: "", api_key: "" };

  if (!provider) {
    // No explicit provider — auto-detect from available keys.
    if (env.ANTHROPIC_API_KEY) {
      base.provider = "anthropic";
      base.default = model || "claude-sonnet-4-5-20251001";
    } else if (env.OPENROUTER_API_KEY) {
      base.provider = "openrouter";
      base.default = model || "anthropic/claude-sonnet-4-5";
    } else if (env.OPENAI_API_KEY) {
      base.provider = "openai";
      base.default = model || "gpt-4o";
    } else if (env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY) {
      base.provider = "google";
      base.default = model || "gemini-2.0-flash";
    } else if (env.NVIDIA_API_KEY) {
      base.provider = "custom";
      base.default = model || "meta/llama-3.1-70b-instruct";
      base.base_url = "https://integrate.api.nvidia.com/v1";
      base.api_key = env.NVIDIA_API_KEY;
    } else if (env.GROQ_API_KEY) {
      base.provider = "custom";
      base.default = model || "llama-3.3-70b-versatile";
      base.base_url = "https://api.groq.com/openai/v1";
      base.api_key = env.GROQ_API_KEY;
    } else if (env.LITELLM_BASE_URL && env.LITELLM_API_KEY) {
      base.provider = "custom";
      base.default = model || litellmModel || "best";
      base.base_url = env.LITELLM_BASE_URL;
      base.api_key = env.LITELLM_API_KEY;
    }
    return pruneModelConfig(base);
  }

  switch (provider) {
    case "litellm": {
      base.provider = "custom";
      base.default = model || litellmModel || "best";
      base.base_url = env.LITELLM_BASE_URL || "";
      base.api_key = env.LITELLM_API_KEY || "";
      break;
    }
    case "anthropic": {
      base.provider = "anthropic";
      base.default = model || "claude-sonnet-4-5-20251001";
      break;
    }
    case "openai": {
      if (env.OPENAI_BASE_URL) {
        // Custom OpenAI-compatible endpoint (e.g., Azure, local proxy)
        base.provider = "custom";
        base.base_url = env.OPENAI_BASE_URL;
        base.api_key = env.OPENAI_API_KEY || "";
      } else {
        // Standard OpenAI API-key authentication
        // (NOT openai-codex — that is an OAuth subscription provider)
        base.provider = "openai";
      }
      base.default = model || "gpt-4o";
      break;
    }
    case "openrouter": {
      base.provider = "openrouter";
      base.default = model || "anthropic/claude-sonnet-4-5";
      break;
    }
    case "gemini": {
      base.provider = "google";
      base.default = model || "gemini-2.0-flash";
      break;
    }
    case "nvidia": {
      base.provider = "custom";
      base.default = model || "meta/llama-3.1-70b-instruct";
      base.base_url = "https://integrate.api.nvidia.com/v1";
      base.api_key = env.NVIDIA_API_KEY || "";
      break;
    }
    case "groq": {
      base.provider = "custom";
      base.default = model || "llama-3.3-70b-versatile";
      base.base_url = "https://api.groq.com/openai/v1";
      base.api_key = env.GROQ_API_KEY || "";
      break;
    }
    default: {
      // Unknown provider — pass through as-is (may be a custom Hermes provider)
      base.provider = provider;
      base.default = model || "";
      break;
    }
  }
  return pruneModelConfig(base);
}

/** Remove empty fields from the model config to avoid writing null/empty YAML. */
function pruneModelConfig(cfg) {
  const out = {};
  if (cfg.provider) out.provider = cfg.provider;
  if (cfg.default) out.default = cfg.default;
  if (cfg.base_url) out.base_url = normalizeBaseUrl(cfg.base_url);
  if (cfg.api_key) out.api_key = cfg.api_key;
  return out;
}

/**
 * Normalises a base URL for Hermes:
 *   - Strips trailing slashes.
 *   - Appends /v1 for OpenAI-compatible servers (Hermes appends /chat/completions directly).
 *   - Preserves existing /v1 suffixes (idempotent).
 *   - Does NOT modify URLs that already have a non-/v1 path suffix
 *     (e.g., /gemini, /openai/v1, /api/v1).
 */
export function normalizeBaseUrl(url) {
  if (!url) return "";
  let u = url.replace(/\/+$/, "");
  // Only add /v1 if the URL has no path at all or ends with a bare domain.
  // If the URL already has a meaningful path (e.g., /gemini, /openai/v1),
  // leave it as-is.
  const pathOnly = u.replace(/^https?:\/\/[^/]+/, "");
  if (pathOnly === "" || pathOnly === "/" || pathOnly === "/v1") {
    if (pathOnly !== "/v1") u += "/v1";
  }
  return u;
}

// ─── .env management ────────────────────────────────────────────────────────
// Keys that Devlet explicitly manages in .env. Any other existing entry
// (e.g., Telegram bot tokens, user-added keys) is preserved.
export const MANAGED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "NVIDIA_API_KEY",
  "FIRECRAWL_API_KEY",
  "TAVILY_API_KEY",
];

/**
 * Merges managed env vars into an existing .env file.
 * Existing entries for unmanaged keys are always preserved.
 * Managed keys are set from env (empty string removes the entry).
 *
 * @param {Record<string, string>} existingEnv - parsed existing .env entries
 * @param {Record<string, string>} env - current process environment
 * @returns {Record<string, string>} merged .env entries
 */
export function mergeEnv(existingEnv, env) {
  const result = { ...existingEnv };
  for (const key of MANAGED_ENV_KEYS) {
    const val = env[key];
    if (val) {
      result[key] = val;
    } else {
      delete result[key];
    }
  }
  return result;
}

/**
 * Parses a .env file content into an object.
 * Handles: KEY=VALUE, # comments, empty lines, values with special chars.
 * Does NOT handle: multi-line values, variable expansion, export prefix.
 * (These are not expected in Hermes .env files.)
 */
export function parseDotEnv(content) {
  const result = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Serialises an env object to .env file content.
 * Values are written as-is (no quoting) since Hermes expects raw KEY=VALUE.
 * Keys are written in a stable order: managed keys first (alphabetical), then others.
 */
export function serializeDotEnv(env) {
  const managed = MANAGED_ENV_KEYS.filter((k) => env[k] !== undefined).sort();
  const others = Object.keys(env)
    .filter((k) => !MANAGED_ENV_KEYS.includes(k))
    .sort();
  const lines = [];
  for (const key of [...managed, ...others]) {
    lines.push(`${key}=${env[key]}`);
  }
  return lines.join("\n") + "\n";
}

// ─── Config merge ───────────────────────────────────────────────────────────

/**
 * Deep-merges two config objects. `overrides` wins over `base`.
 * Nested objects are merged recursively; non-object values are replaced.
 * Arrays are replaced (not concatenated).
 */
export function deepMerge(base, overrides) {
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return overrides !== undefined ? structuredClone(overrides) : structuredClone(base);
  }
  const result = { ...base };
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) continue;
    if (isPlainObject(val) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], val);
    } else {
      result[key] = structuredClone(val);
    }
  }
  return result;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Computes the final config.yaml content by applying the merge policy:
 *   baseline < existing < explicit overrides
 *
 * @param {object} existingConfig - parsed existing config.yaml (or null/undefined for first boot)
 * @param {object} modelOverrides - the resolved model block (from resolveModelConfig)
 * @param {object} tuningOverrides - optional tuning overrides (context, compression, etc.)
 * @returns {object} the merged config object
 */
export function computeConfig(existingConfig, modelOverrides, tuningOverrides = {}) {
  const baseline = buildBaseline();

  // Layer 1: baseline
  let config = structuredClone(baseline);

  // Layer 2: existing settings (preserved from previous runs)
  if (existingConfig && isPlainObject(existingConfig)) {
    config = deepMerge(config, existingConfig);
  }

  // Layer 3: explicit overrides (highest priority)
  // The model block is an atomic override — it is REPLACED, not merged.
  // This ensures that switching from a custom provider (with base_url/api_key)
  // to a native provider (anthropic, openai) cleanly removes stale fields.
  if (modelOverrides && Object.keys(modelOverrides).length > 0) {
    config.model = { ...modelOverrides };
  }
  // Apply tuning overrides (these merge into their respective sections)
  for (const [section, values] of Object.entries(tuningOverrides)) {
    if (values && isPlainObject(values)) {
      config[section] = deepMerge(config[section] || {}, values);
    }
  }

  // Remove internal marker from output
  delete config._devlet;

  return config;
}

// ─── Atomic file operations ─────────────────────────────────────────────────

/**
 * Writes content to a file atomically (write to .tmp, then rename).
 * Sets permissions to 0600.
 */
export function atomicWrite(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${path.basename(filePath)}-${process.pid}`);
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, filePath);
  // Ensure permissions are correct even if the file already existed
  fs.chmodSync(filePath, mode);
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Full configuration setup. Called by the entrypoint or tests.
 *
 * @param {object} opts
 * @param {string} opts.hermesHome - path to HERMES_HOME (e.g., /home/agent/.hermes)
 * @param {string} [opts.provider] - DEVLET_AGENT_PROVIDER
 * @param {string} [opts.model] - DEVLET_AGENT_MODEL
 * @param {object} [opts.env] - environment (defaults to process.env)
 * @param {string} [opts.litellmModel] - pre-resolved LiteLLM model
 * @param {object} [opts.tuning] - explicit tuning overrides
 * @returns {{ configPath: string, envPath: string, wroteConfig: boolean, wroteEnv: boolean }}
 */
export function configureHermes(opts) {
  const hermesHome = opts.hermesHome || path.join(os.homedir(), ".hermes");
  const env = opts.env || process.env;
  const provider = opts.provider || env.DEVLET_AGENT_PROVIDER || "";
  const model = opts.model || env.DEVLET_AGENT_MODEL || "";
  const litellmModel = opts.litellmModel || "";
  const tuning = opts.tuning || {};

  const configPath = path.join(hermesHome, "config.yaml");
  const envPath = path.join(hermesHome, ".env");

  // ─── Config.yaml ──────────────────────────────────────────────────────────
  let existingConfig = null;
  let configError = null;

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf8");
      existingConfig = yaml.load(raw);
      if (existingConfig !== null && typeof existingConfig !== "object") {
        configError = `config.yaml is not a mapping (got ${typeof existingConfig})`;
      }
    } catch (err) {
      configError = `Failed to parse config.yaml: ${err.message}`;
    }
  }

  if (configError) {
    // NEVER overwrite a valid existing config when parsing fails.
    // Log the error and leave the file untouched.
    console.error(`[hermes-config] ERROR: ${configError}`);
    console.error("[hermes-config] Existing config.yaml left unchanged. Fix the file and restart.");
  } else {
    // Resolve model config from env
    const modelOverrides = resolveModelConfig(provider, model, env, litellmModel);

    // Build tuning overrides from env
    const tuningOverrides = {};
    if (env.HERMES_CONTEXT_TOKENS) {
      const ctx = parseInt(env.HERMES_CONTEXT_TOKENS, 10);
      if (!isNaN(ctx) && ctx > 0) {
        tuningOverrides.model = { context_tokens: ctx };
      }
    }
    if (env.HERMES_COMPRESSION_THRESHOLD_TOKENS) {
      const t = parseInt(env.HERMES_COMPRESSION_THRESHOLD_TOKENS, 10);
      if (!isNaN(t) && t > 0) {
        tuningOverrides.compression = { threshold_tokens: t };
      }
    }
    if (env.HERMES_MAX_TURNS) {
      const t = parseInt(env.HERMES_MAX_TURNS, 10);
      if (!isNaN(t) && t > 0) {
        tuningOverrides.agent = { max_turns: t };
      }
    }
    if (env.HERMES_MAX_DELEGATION_ITERATIONS) {
      const t = parseInt(env.HERMES_MAX_DELEGATION_ITERATIONS, 10);
      if (!isNaN(t) && t > 0) {
        tuningOverrides.delegation = { max_iterations: t };
      }
    }
    if (env.HERMES_COMPRESSION_TIMEOUT) {
      const t = parseInt(env.HERMES_COMPRESSION_TIMEOUT, 10);
      if (!isNaN(t) && t > 0) {
        tuningOverrides.auxiliary = { compression: { timeout: t } };
      }
    }
    if (env.HERMES_TITLE_MODEL_UPGRADE) {
      const enabled = /^(1|true|yes|on)$/i.test(env.HERMES_TITLE_MODEL_UPGRADE);
      tuningOverrides.auxiliary = {
        ...(tuningOverrides.auxiliary || {}),
        title_generation: { model_upgrade_enabled: enabled },
      };
    }

    const merged = computeConfig(existingConfig, modelOverrides, tuningOverrides);
    const yamlContent = yaml.dump(merged, {
      noRefs: true,
      sortKeys: false,
      lineWidth: 120,
    });
    atomicWrite(configPath, yamlContent);
    console.log(`[hermes-config] config.yaml written to ${configPath}`);
  }

  // ─── .env ─────────────────────────────────────────────────────────────────
  let existingEnv = {};
  if (fs.existsSync(envPath)) {
    try {
      const raw = fs.readFileSync(envPath, "utf8");
      existingEnv = parseDotEnv(raw);
    } catch {
      // If .env can't be read, start fresh (it's less critical than config.yaml)
      existingEnv = {};
    }
  }
  const mergedEnv = mergeEnv(existingEnv, env);
  const envContent = serializeDotEnv(mergedEnv);
  atomicWrite(envPath, envContent);
  console.log(`[hermes-config] .env written to ${envPath} (${Object.keys(mergedEnv).length} entries)`);

  return {
    configPath,
    envPath,
    wroteConfig: !configError,
    wroteEnv: true,
    configError: configError || null,
  };
}

// ─── CLI entry point ────────────────────────────────────────────────────────
// When run as a script (not imported), execute the full configuration.
// The entrypoint passes the LiteLLM model via HERMES_LITELLM_MODEL env var
// (resolved by the shell before calling node, avoiding the shell-interp problem).
const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const result = configureHermes({
    hermesHome: process.env.HERMES_HOME,
    litellmModel: process.env.HERMES_LITELLM_MODEL || "",
  });
  if (result.configError) {
    process.exit(1);
  }
}
