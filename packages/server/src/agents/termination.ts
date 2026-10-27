import type { AgentState } from "@devlet/shared";
import { sanitizeEnvValue } from "./sanitize.js";

/** Bound retained output and redact known agent credentials before persisting it. */
export function diagnosticText(text: string, env: Record<string, string>): string {
  for (const [key, value] of Object.entries(env)) {
    if (value && sanitizeEnvValue(key, value) !== value) text = text.split(value).join("[redacted]");
  }
  return text.replace(/(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret|authorization)"?\s*[=:]\s*)(?:"[^"\n]*"|[^\s,;}]+)/gi, "$1[redacted]");
}

export async function retainTermination(state: AgentState, deps: {
  logs: () => Promise<string[]>;
  details: () => Promise<unknown>;
  save: (state: AgentState) => Promise<void>;
  cleanup: () => Promise<void>;
  captureTimeoutMs?: number;
}): Promise<void> {
  const at = new Date().toISOString();
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Diagnostic capture timed out")), deps.captureTimeoutMs ?? 10000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  const [logs, details] = await Promise.allSettled([bounded(deps.logs), bounded(deps.details)]);
  const output = logs.status === "fulfilled" ? logs.value : [];
  const header = `[devlet] termination observed at ${at}; runtime=${state.platformRef}`;
  const detail = details.status === "fulfilled" ? JSON.stringify(details.value) : "runtime details unavailable";
  const tail = output.length ? output.slice(-500).join("\n").slice(-65536) : "[devlet] runtime logs unavailable or empty";
  state.logs.push(header, diagnosticText(detail ?? "runtime details unavailable", state.config.env).slice(0, 4096), diagnosticText(tail, state.config.env));
  state.status = "terminated";
  state.logs.push("[devlet] container exited — marked terminated");
  // Never destroy the only evidence before the state write succeeds.
  await deps.save(state);
  // Failed capture leaves the runtime for manual inspection. Empty logs can be valid.
  if (logs.status === "rejected" || details.status === "rejected") return;
  try { await deps.cleanup(); } catch {
    state.logs.push("[devlet] runtime cleanup failed; retained for inspection");
    await deps.save(state);
  }
}

export function provisioningError(error: unknown, env: Record<string, string>): string {
  let text: string;
  try { text = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error); }
  catch { text = "Unserializable provisioning error"; }
  return diagnosticText(text || "Unknown provisioning error", env).slice(0, 4096);
}
