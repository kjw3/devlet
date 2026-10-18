import assert from "node:assert/strict";
import { test, describe, before, after, beforeEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import {
  buildBaseline,
  resolveModelConfig,
  normalizeBaseUrl,
  mergeEnv,
  parseDotEnv,
  serializeDotEnv,
  deepMerge,
  computeConfig,
  configureHermes,
  atomicWrite,
  MANAGED_ENV_KEYS,
} from "./hermes-config.mjs";

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-config-test-"));
});

after(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function makeHome() {
  const home = path.join(tmpDir, ".hermes");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function fileMode(file) {
  return fs.statSync(file).mode & 0o777;
}

// ─── Tests: buildBaseline ───────────────────────────────────────────────────

describe("buildBaseline", () => {
  test("returns expected structure with versioned baseline", () => {
    const b = buildBaseline();
    assert.equal(b._devlet.baseline_version, "v2026.9.24");
    assert.equal(b.terminal.backend, "local");
    assert.equal(b.terminal.cwd, "/workspace");
    assert.equal(b.terminal.home_mode, "real");
    assert.equal(b.agent.max_turns, 100);
    assert.equal(b.delegation.max_iterations, 50);
    assert.equal(b.compression.enabled, true);
    assert.equal(b.auxiliary.compression.timeout, 120);
    assert.equal(b.auxiliary.title_generation.model_upgrade_enabled, false);
  });

  test("does not include a model section", () => {
    const b = buildBaseline();
    assert.equal(b.model, undefined);
  });
});

// ─── Tests: normalizeBaseUrl ────────────────────────────────────────────────

describe("normalizeBaseUrl", () => {
  test("appends /v1 to bare domain", () => {
    assert.equal(normalizeBaseUrl("https://litellm.example.com"), "https://litellm.example.com/v1");
  });

  test("strips trailing slashes then appends /v1", () => {
    assert.equal(normalizeBaseUrl("https://litellm.example.com///"), "https://litellm.example.com/v1");
  });

  test("preserves existing /v1 (idempotent)", () => {
    assert.equal(normalizeBaseUrl("https://litellm.example.com/v1"), "https://litellm.example.com/v1");
  });

  test("preserves /v1 with trailing slash", () => {
    assert.equal(normalizeBaseUrl("https://litellm.example.com/v1/"), "https://litellm.example.com/v1");
  });

  test("preserves non-/v1 paths (e.g., /openai/v1)", () => {
    assert.equal(normalizeBaseUrl("https://api.groq.com/openai/v1"), "https://api.groq.com/openai/v1");
  });

  test("preserves /gemini path", () => {
    assert.equal(normalizeBaseUrl("https://litellm.example.com/gemini"), "https://litellm.example.com/gemini");
  });

  test("preserves /api/v1 path", () => {
    assert.equal(normalizeBaseUrl("https://example.com/api/v1"), "https://example.com/api/v1");
  });

  test("handles empty string", () => {
    assert.equal(normalizeBaseUrl(""), "");
  });

  test("handles localhost", () => {
    assert.equal(normalizeBaseUrl("http://localhost:8080"), "http://localhost:8080/v1");
  });
});

// ─── Tests: resolveModelConfig ──────────────────────────────────────────────

describe("resolveModelConfig", () => {
  test("openai without base_url maps to 'openai' (NOT openai-codex)", () => {
    const result = resolveModelConfig("openai", "", { OPENAI_API_KEY: "sk-test" });
    assert.equal(result.provider, "openai");
    assert.equal(result.default, "gpt-4o");
    assert.equal(result.base_url, undefined);
  });

  test("openai with base_url maps to 'custom'", () => {
    const result = resolveModelConfig("openai", "my-model", {
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: "https://custom.example.com",
    });
    assert.equal(result.provider, "custom");
    assert.equal(result.base_url, "https://custom.example.com/v1");
    assert.equal(result.api_key, "sk-test");
  });

  test("litellm maps to 'custom' with base_url", () => {
    const result = resolveModelConfig("litellm", "decent-chat", {
      LITELLM_BASE_URL: "https://litellm.kdjlab.com",
      LITELLM_API_KEY: "sk-litellm",
    });
    assert.equal(result.provider, "custom");
    assert.equal(result.default, "decent-chat");
    assert.equal(result.base_url, "https://litellm.kdjlab.com/v1");
    assert.equal(result.api_key, "sk-litellm");
  });

  test("anthropic maps natively", () => {
    const result = resolveModelConfig("anthropic", "claude-opus-4", { ANTHROPIC_API_KEY: "sk-ant" });
    assert.equal(result.provider, "anthropic");
    assert.equal(result.default, "claude-opus-4");
    assert.equal(result.base_url, undefined);
    assert.equal(result.api_key, undefined);
  });

  test("gemini maps to 'google'", () => {
    const result = resolveModelConfig("gemini", "gemini-2.0-pro", { GEMINI_API_KEY: "g-api-key" });
    assert.equal(result.provider, "google");
    assert.equal(result.default, "gemini-2.0-pro");
  });

  test("nvidia maps to 'custom' with NIM endpoint", () => {
    const result = resolveModelConfig("nvidia", "nvidia/llama", { NVIDIA_API_KEY: "nv-key" });
    assert.equal(result.provider, "custom");
    assert.equal(result.base_url, "https://integrate.api.nvidia.com/v1");
    assert.equal(result.api_key, "nv-key");
  });

  test("groq maps to 'custom' with Groq endpoint", () => {
    const result = resolveModelConfig("groq", "llama-3.3-70b", { GROQ_API_KEY: "gq-key" });
    assert.equal(result.provider, "custom");
    assert.equal(result.base_url, "https://api.groq.com/openai/v1");
    assert.equal(result.api_key, "gq-key");
  });

  test("auto-detect prefers anthropic when key present", () => {
    const result = resolveModelConfig("", "", {
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oai",
    });
    assert.equal(result.provider, "anthropic");
  });

  test("auto-detect falls through to openai", () => {
    const result = resolveModelConfig("", "", { OPENAI_API_KEY: "sk-oai" });
    assert.equal(result.provider, "openai");
  });

  test("auto-detect falls through to gemini", () => {
    const result = resolveModelConfig("", "", { GEMINI_API_KEY: "g-key" });
    assert.equal(result.provider, "google");
  });

  test("explicit model overrides default", () => {
    const result = resolveModelConfig("openai", "gpt-5-turbo", { OPENAI_API_KEY: "sk" });
    assert.equal(result.default, "gpt-5-turbo");
  });

  test("litellm uses pre-resolved model when no explicit model", () => {
    const result = resolveModelConfig("litellm", "", {
      LITELLM_BASE_URL: "https://llm.example.com",
      LITELLM_API_KEY: "key",
    }, "resolved-model-42");
    assert.equal(result.default, "resolved-model-42");
  });
});

// ─── Tests: parseDotEnv / serializeDotEnv ───────────────────────────────────

describe("parseDotEnv", () => {
  test("parses simple KEY=VALUE pairs", () => {
    const result = parseDotEnv("FOO=bar\nBAZ=qux\n");
    assert.deepEqual(result, { FOO: "bar", BAZ: "qux" });
  });

  test("skips comments and empty lines", () => {
    const result = parseDotEnv("# comment\n\nFOO=bar\n# another\n");
    assert.deepEqual(result, { FOO: "bar" });
  });

  test("handles values with special characters", () => {
    const result = parseDotEnv('KEY=value with "quotes" and = signs\n');
    assert.equal(result.KEY, 'value with "quotes" and = signs');
  });

  test("handles empty values", () => {
    const result = parseDotEnv("EMPTY=\n");
    assert.equal(result.EMPTY, "");
  });
});

describe("serializeDotEnv", () => {
  test("serializes managed keys first, then others", () => {
    const result = serializeDotEnv({ TELEGRAM_BOT_TOKEN: "tg-123", ANTHROPIC_API_KEY: "sk-ant" });
    const lines = result.trim().split("\n");
    assert.ok(lines[0].startsWith("ANTHROPIC_API_KEY="));
    assert.ok(lines[1].startsWith("TELEGRAM_BOT_TOKEN="));
  });

  test("round-trips through parse", () => {
    const original = { ANTHROPIC_API_KEY: "sk-ant", MY_CUSTOM_KEY: "hello world" };
    const serialized = serializeDotEnv(original);
    const parsed = parseDotEnv(serialized);
    assert.deepEqual(parsed, original);
  });
});

// ─── Tests: mergeEnv ────────────────────────────────────────────────────────

describe("mergeEnv", () => {
  test("preserves unmanaged keys from existing .env", () => {
    const existing = { TELEGRAM_BOT_TOKEN: "tg-secret-123", MY_CUSTOM: "value" };
    const env = { ANTHROPIC_API_KEY: "sk-ant" };
    const result = mergeEnv(existing, env);
    assert.equal(result.TELEGRAM_BOT_TOKEN, "tg-secret-123");
    assert.equal(result.MY_CUSTOM, "value");
    assert.equal(result.ANTHROPIC_API_KEY, "sk-ant");
  });

  test("updates managed keys from env", () => {
    const existing = { OPENAI_API_KEY: "old-key" };
    const env = { OPENAI_API_KEY: "new-key" };
    const result = mergeEnv(existing, env);
    assert.equal(result.OPENAI_API_KEY, "new-key");
  });

  test("removes managed keys not in env", () => {
    const existing = { GROQ_API_KEY: "gq-old" };
    const env = {};
    const result = mergeEnv(existing, env);
    assert.equal(result.GROQ_API_KEY, undefined);
  });

  test("does not mutate the input existing object", () => {
    const existing = { TELEGRAM_BOT_TOKEN: "tg" };
    mergeEnv(existing, { ANTHROPIC_API_KEY: "sk" });
    assert.equal(existing.TELEGRAM_BOT_TOKEN, "tg");
    assert.equal(existing.ANTHROPIC_API_KEY, undefined);
  });
});

// ─── Tests: deepMerge ───────────────────────────────────────────────────────

describe("deepMerge", () => {
  test("nested objects are merged recursively", () => {
    const base = { a: { x: 1, y: 2 }, b: 3 };
    const override = { a: { y: 99, z: 99 } };
    const result = deepMerge(base, override);
    assert.deepEqual(result, { a: { x: 1, y: 99, z: 99 }, b: 3 });
  });

  test("non-object values replace", () => {
    const result = deepMerge({ a: { x: 1 } }, { a: "string" });
    assert.deepEqual(result, { a: "string" });
  });

  test("arrays are replaced, not concatenated", () => {
    const result = deepMerge({ a: [1, 2, 3] }, { a: [4, 5] });
    assert.deepEqual(result, { a: [4, 5] });
  });

  test("does not mutate inputs", () => {
    const base = { a: { x: 1 } };
    const override = { a: { y: 2 } };
    deepMerge(base, override);
    assert.deepEqual(base, { a: { x: 1 } });
    assert.deepEqual(override, { a: { y: 2 } });
  });
});

// ─── Tests: computeConfig ───────────────────────────────────────────────────

describe("computeConfig", () => {
  test("first boot: baseline + model overrides", () => {
    const model = { provider: "anthropic", default: "claude-sonnet-4-5-20251001" };
    const config = computeConfig(null, model);
    assert.equal(config.model.provider, "anthropic");
    assert.equal(config.model.default, "claude-sonnet-4-5-20251001");
    assert.equal(config.terminal.backend, "local");
    assert.equal(config.terminal.cwd, "/workspace");
    assert.equal(config.agent.max_turns, 100);
    assert.equal(config._devlet, undefined);
  });

  test("restart: existing settings preserved", () => {
    const existing = {
      model: { provider: "anthropic", default: "claude-3-opus" },
      memory: { enabled: true, custom_setting: "keep-me" },
      terminal: { backend: "local", cwd: "/workspace" },
      tools: { custom: true },
    };
    const model = { provider: "anthropic", default: "claude-sonnet-4-5-20251001" };
    const config = computeConfig(existing, model);
    // Model is overridden
    assert.equal(config.model.default, "claude-sonnet-4-5-20251001");
    // Unrelated settings preserved
    assert.deepEqual(config.memory, { enabled: true, custom_setting: "keep-me" });
    assert.equal(config.tools.custom, true);
    // Baseline settings still present
    assert.equal(config.compression.enabled, true);
    assert.equal(config.delegation.max_iterations, 50);
  });

  test("provider switch: model block updated, other settings preserved", () => {
    const existing = {
      model: { provider: "custom", default: "old-model", base_url: "https://old.example.com/v1", api_key: "old-key" },
      compression: { enabled: true, threshold_tokens: 32000 },
      memory: { user_profile: true },
    };
    const model = { provider: "anthropic", default: "claude-sonnet-4-5" };
    const config = computeConfig(existing, model);
    assert.equal(config.model.provider, "anthropic");
    assert.equal(config.model.default, "claude-sonnet-4-5");
    assert.equal(config.model.base_url, undefined);
    assert.equal(config.model.api_key, undefined);
    // Compression settings preserved from existing
    assert.equal(config.compression.threshold_tokens, 32000);
    // Memory preserved
    assert.equal(config.memory.user_profile, true);
  });

  test("tuning overrides are applied with highest priority", () => {
    const existing = { agent: { max_turns: 200 } };
    const model = { provider: "openai", default: "gpt-4o" };
    const tuning = { agent: { max_turns: 50 } };
    const config = computeConfig(existing, model, tuning);
    assert.equal(config.agent.max_turns, 50);
  });
});

// ─── Tests: configureHermes (integration) ──────────────────────────────────

describe("configureHermes", () => {
  test("first boot creates config.yaml and .env with correct structure", () => {
    const home = makeHome();
    const result = configureHermes({
      hermesHome: home,
      provider: "anthropic",
      model: "claude-sonnet-4-5-20251001",
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    });

    assert.equal(result.wroteConfig, true);
    assert.equal(result.wroteEnv, true);

    const config = readYaml(path.join(home, "config.yaml"));
    assert.equal(config.model.provider, "anthropic");
    assert.equal(config.model.default, "claude-sonnet-4-5-20251001");
    assert.equal(config.terminal.backend, "local");
    assert.equal(config.terminal.cwd, "/workspace");
    assert.equal(config.agent.max_turns, 100);

    const envContent = fs.readFileSync(path.join(home, ".env"), "utf8");
    assert.ok(envContent.includes("ANTHROPIC_API_KEY=sk-ant-test"));
  });

  test("first boot: file permissions are 0600", () => {
    const home = makeHome();
    configureHermes({
      hermesHome: home,
      provider: "openai",
      env: { OPENAI_API_KEY: "sk-test" },
    });

    assert.equal(fileMode(path.join(home, "config.yaml")), 0o600);
    assert.equal(fileMode(path.join(home, ".env")), 0o600);
  });

  test("restart preserves existing config settings", () => {
    const home = makeHome();

    // First boot
    configureHermes({
      hermesHome: home,
      provider: "anthropic",
      env: { ANTHROPIC_API_KEY: "sk-ant" },
    });

    // Simulate user modifying config (e.g., adding custom settings)
    const configPath = path.join(home, "config.yaml");
    let config = readYaml(configPath);
    config.memory = { custom_behavior: "user-set" };
    config.compression = { enabled: true, threshold_tokens: 50000 };
    fs.writeFileSync(configPath, yaml.dump(config));

    // Restart with same provider
    configureHermes({
      hermesHome: home,
      provider: "anthropic",
      env: { ANTHROPIC_API_KEY: "sk-ant" },
    });

    const afterRestart = readYaml(configPath);
    assert.equal(afterRestart.memory.custom_behavior, "user-set");
    assert.equal(afterRestart.compression.threshold_tokens, 50000);
    assert.equal(afterRestart.model.provider, "anthropic");
    assert.equal(afterRestart.terminal.backend, "local");
  });

  test("provider switch updates model but preserves other settings", () => {
    const home = makeHome();

    // Initial: litellm
    configureHermes({
      hermesHome: home,
      provider: "litellm",
      model: "decent-chat",
      env: {
        LITELLM_BASE_URL: "https://litellm.example.com",
        LITELLM_API_KEY: "llm-key",
      },
    });

    const configPath = path.join(home, "config.yaml");
    let config = readYaml(configPath);
    assert.equal(config.model.provider, "custom");
    assert.equal(config.model.default, "decent-chat");

    // Simulate user adding a custom setting
    config.custom_tools = { enabled: true, list: ["my-tool"] };
    fs.writeFileSync(configPath, yaml.dump(config));

    // Switch to anthropic
    configureHermes({
      hermesHome: home,
      provider: "anthropic",
      env: { ANTHROPIC_API_KEY: "sk-ant" },
    });

    const after = readYaml(configPath);
    assert.equal(after.model.provider, "anthropic");
    assert.equal(after.model.base_url, undefined);
    assert.equal(after.model.api_key, undefined);
    // User's custom settings preserved
    assert.deepEqual(after.custom_tools, { enabled: true, list: ["my-tool"] });
    // Baseline still present
    assert.equal(after.terminal.cwd, "/workspace");
  });

  test(".env preserves unmanaged entries across restarts", () => {
    const home = makeHome();

    // First boot
    configureHermes({
      hermesHome: home,
      provider: "openai",
      env: { OPENAI_API_KEY: "sk-oai" },
    });

    // Simulate user adding a Telegram token to .env
    const envPath = path.join(home, ".env");
    let envContent = fs.readFileSync(envPath, "utf8");
    envContent += "TELEGRAM_BOT_TOKEN=123456:ABC-DEF\n";
    fs.writeFileSync(envPath, envContent);

    // Restart
    configureHermes({
      hermesHome: home,
      provider: "openai",
      env: { OPENAI_API_KEY: "sk-oai-2" },
    });

    const finalEnv = fs.readFileSync(envPath, "utf8");
    assert.ok(finalEnv.includes("TELEGRAM_BOT_TOKEN=123456:ABC-DEF"));
    assert.ok(finalEnv.includes("OPENAI_API_KEY=sk-oai-2"));
  });

  test(".env permissions are 0600 after restart", () => {
    const home = makeHome();
    configureHermes({ hermesHome: home, provider: "openai", env: { OPENAI_API_KEY: "sk" } });
    assert.equal(fileMode(path.join(home, ".env")), 0o600);
  });

  test("malformed config.yaml is NOT overwritten", () => {
    const home = makeHome();
    const configPath = path.join(home, "config.yaml");

    // Write a malformed YAML file
    fs.writeFileSync(configPath, "this is: [not valid: yaml: {{{");

    // configureHermes should detect the parse error and leave the file alone
    const result = configureHermes({
      hermesHome: home,
      provider: "anthropic",
      env: { ANTHROPIC_API_KEY: "sk" },
    });

    assert.equal(result.wroteConfig, false);
    // File is unchanged
    const content = fs.readFileSync(configPath, "utf8");
    assert.equal(content, "this is: [not valid: yaml: {{{");
  });

  test("non-mapping config.yaml is NOT overwritten", () => {
    const home = makeHome();
    const configPath = path.join(home, "config.yaml");
    fs.writeFileSync(configPath, "just a string\n");

    const result = configureHermes({
      hermesHome: home,
      provider: "anthropic",
      env: { ANTHROPIC_API_KEY: "sk" },
    });

    assert.equal(result.wroteConfig, false);
    assert.equal(fs.readFileSync(configPath, "utf8"), "just a string\n");
  });

  test("strings with quotes are handled correctly in YAML", () => {
    const home = makeHome();
    configureHermes({
      hermesHome: home,
      provider: "openai",
      model: 'model with "quotes" and \'single\' chars',
      env: { OPENAI_API_KEY: "sk-with-special-chars=!$%" },
    });

    const config = readYaml(path.join(home, "config.yaml"));
    assert.equal(config.model.default, 'model with "quotes" and \'single\' chars');
  });

  test("strings with YAML special characters survive round-trip", () => {
    const home = makeHome();
    configureHermes({
      hermesHome: home,
      provider: "litellm",
      model: "my-model",
      env: {
        LITELLM_BASE_URL: "https://litellm.example.com",
        LITELLM_API_KEY: "key with: colon and # hash and 'quotes'",
      },
    });

    const config = readYaml(path.join(home, "config.yaml"));
    assert.equal(config.model.api_key, "key with: colon and # hash and 'quotes'");
    assert.equal(config.model.base_url, "https://litellm.example.com/v1");
  });

  test("tuning overrides from env are applied", () => {
    const home = makeHome();
    configureHermes({
      hermesHome: home,
      provider: "openai",
      env: {
        OPENAI_API_KEY: "sk",
        HERMES_MAX_TURNS: "200",
        HERMES_MAX_DELEGATION_ITERATIONS: "75",
        HERMES_COMPRESSION_TIMEOUT: "300",
        HERMES_CONTEXT_TOKENS: "128000",
        HERMES_COMPRESSION_THRESHOLD_TOKENS: "96000",
      },
    });

    const config = readYaml(path.join(home, "config.yaml"));
    assert.equal(config.agent.max_turns, 200);
    assert.equal(config.delegation.max_iterations, 75);
    assert.equal(config.auxiliary.compression.timeout, 300);
    assert.equal(config.model.context_tokens, 128000);
    assert.equal(config.compression.threshold_tokens, 96000);
  });

  test("HERMES_TITLE_MODEL_UPGRADE can enable title model", () => {
    const home = makeHome();
    configureHermes({
      hermesHome: home,
      provider: "openai",
      env: {
        OPENAI_API_KEY: "sk",
        HERMES_TITLE_MODEL_UPGRADE: "true",
      },
    });

    const config = readYaml(path.join(home, "config.yaml"));
    assert.equal(config.auxiliary.title_generation.model_upgrade_enabled, true);
  });

  test("atomic write: no partial file left on success", () => {
    const home = makeHome();
    configureHermes({ hermesHome: home, provider: "openai", env: { OPENAI_API_KEY: "sk" } });

    // No .tmp files should remain
    const files = fs.readdirSync(home);
    const tmpFiles = files.filter((f) => f.startsWith(".tmp-"));
    assert.equal(tmpFiles.length, 0);
  });
});

// ─── Tests: atomicWrite ─────────────────────────────────────────────────────

describe("atomicWrite", () => {
  test("creates file with correct permissions", () => {
    const file = path.join(tmpDir, "test.txt");
    atomicWrite(file, "hello");
    assert.equal(fs.readFileSync(file, "utf8"), "hello");
    assert.equal(fileMode(file), 0o600);
  });

  test("overwrites existing file atomically", () => {
    const file = path.join(tmpDir, "test.txt");
    atomicWrite(file, "first");
    atomicWrite(file, "second");
    assert.equal(fs.readFileSync(file, "utf8"), "second");
  });

  test("creates parent directories", () => {
    const file = path.join(tmpDir, "a/b/c/test.txt");
    atomicWrite(file, "nested");
    assert.equal(fs.readFileSync(file, "utf8"), "nested");
  });
});

// ─── Tests: MANAGED_ENV_KEYS ───────────────────────────────────────────────

describe("MANAGED_ENV_KEYS", () => {
  test("includes expected keys", () => {
    for (const key of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "GROQ_API_KEY",
      "GEMINI_API_KEY",
      "NVIDIA_API_KEY",
      "FIRECRAWL_API_KEY",
      "TAVILY_API_KEY",
    ]) {
      assert.ok(MANAGED_ENV_KEYS.includes(key), `missing ${key}`);
    }
  });

  test("does not include unrelated keys", () => {
    assert.ok(!MANAGED_ENV_KEYS.includes("TELEGRAM_BOT_TOKEN"));
    assert.ok(!MANAGED_ENV_KEYS.includes("DEVLET_SSH_PORT"));
  });
});
