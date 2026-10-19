import type { AgentState } from "@devlet/shared";

/**
 * Reconcile a PERSISTENT agent against its actual runtime state.
 *
 * This is the self-heal path for power failures / node outages:
 *   • runtime running (`true`): if the agent is stuck in `error` (e.g. it was
 *     flagged when the node went offline, or a manual recovery failed), the
 *     runtime is fine — clear the error and go back to `running`.
 *   • runtime stopped/missing (`false`): reprovision in place. Named volumes
 *     are reused, so workspace/home data survives. Provisioning failures are
 *     persisted as a generic, safe-to-display error and retried on the next
 *     sync cycle (the caller runs this periodically).
 *   • unknown (`null`): the platform may be offline — do nothing here; the
 *     caller is responsible for offline marking.
 *
 * Dependencies are injected (same pattern as provision-recovery.ts) so the
 * decisions are unit-testable without platform access.
 */
export async function reconcilePersistentAgent(
  state: AgentState,
  running: boolean | null,
  deps: {
    provision: () => Promise<string>;
    save: (state: AgentState) => Promise<void>;
  },
): Promise<void> {
  if (running === null) return;

  if (running === true) {
    if (state.status !== "error") return;
    state.status = "running";
    delete state.error;
    state.config.lastActiveAt = new Date().toISOString();
    state.logs.push("[devlet] runtime is running again — error state cleared");
    await deps.save(state);
    return;
  }

  // running === false — reprovision in place.
  try {
    const platformRef = await deps.provision();
    state.platformRef = platformRef;
    state.status = "running";
    delete state.error;
    state.config.lastActiveAt = new Date().toISOString();
    state.logs.push("[devlet] persistent agent was stopped or missing — reprovisioned");
  } catch (err) {
    console.error(`[runtime-reconcile] auto-recovery failed for ${state.config.id}:`, err);
    state.status = "error";
    // Provisioning exceptions can embed bootstrap scripts or credentials, so
    // keep the stored error generic and safe to surface in the UI (see
    // provision-recovery.ts). The full error is on the server log.
    state.error = "Auto-recovery failed — the runtime could not be started. It will be retried automatically.";
    state.logs.push(`[devlet] ${state.error}`);
  }
  await deps.save(state);
}
