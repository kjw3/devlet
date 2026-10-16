/**
 * Pure agent-state serialization for tRPC responses.
 *
 * `sanitizeAgentStateSummary` performs NO remote work: no platform probes, no
 * access discovery, no tailnet lookups. It is safe to run for the whole fleet
 * on every list request. Access enrichment (which may resolve hosts) lives in
 * the detail path only (`enrichAgentAccess` in routers/index.ts).
 */
import type { AgentState } from "@devlet/shared";

const INTERNAL_ONLY_ENV_KEYS = new Set([
  "DEVLET_TERMINAL_PORT",
  "DEVLET_SSH_PORT",
  "DEVLET_SSH_USERNAME",
  "DEVLET_SSH_AUTHORIZED_KEYS_B64",
  "DEVLET_SSH_HOST_KEY_PRIVATE_B64",
  "DEVLET_SSH_HOST_KEY_PUBLIC_B64",
  "DEVLET_SSH_HOST_KEY_FINGERPRINT",
  "OPENCLAW_HOST_PORT",
  "OPENCLAW_ALLOWED_ORIGINS",
  "OPENCLAW_GATEWAY_TOKEN",
  "MOLTIS_HOST_PORT",
  "MOLTIS_PASSWORD",
]);

/**
 * Values that look like credentials are redacted: keys ENDING in a secret-ish
 * token, or CONTAINING session/credential markers. Over-redaction is safe —
 * agents still receive their real env from the platform; this list only
 * governs what the web UI can read.
 */
const SECRET_ENV_PATTERNS = [
  /(^|_)(API_KEY|ACCESS_KEY|SECRET(_KEY)?|TOKEN|PASSWORD|PASSPHRASE|CREDENTIALS?|AUTHORIZATION)$/i,
  /PRIVATE_KEY/i,
  /SESSION/i,
];

/** Redact internal-only and secret-looking env values. Pure. */
export function sanitizeEnvValue(key: string, value: string): string | null {
  if (INTERNAL_ONLY_ENV_KEYS.has(key)) {
    return null;
  }

  if (SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
    return "[redacted]";
  }

  return value;
}

/** Env map with internal/secret values removed or redacted. Pure. */
export function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .map(([key, value]) => [key, sanitizeEnvValue(key, value)] as const)
      .filter((entry): entry is [string, string] => entry[1] !== null)
  );
}

/**
 * Fast, pure summary of an agent for list responses: env redacted, `access`
 * stripped (it is detail-only and can require host discovery). Runs zero
 * platform calls regardless of fleet size or platform health.
 */
export function sanitizeAgentStateSummary(state: AgentState): AgentState {
  const { access: _access, ...rest } = state;
  return { ...rest, config: { ...state.config, env: sanitizeEnv(state.config.env) } };
}
