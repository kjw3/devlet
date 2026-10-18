import type { AgentState } from "@devlet/shared";
import { provisionAgent } from "../platforms/dispatch.js";
import { loadAgentState, saveAgentState } from "./state.js";

/**
 * Recover agents left in `provisioning` when the server restarted (or crashed)
 * mid-provision. This covers both `hire` and `rebuild`, which flip status to
 * `provisioning` up front and then provision asynchronously — a restart in that
 * window would otherwise leave the agent stuck on `provisioning` (the reconciler
 * skips that status, so nothing else would pick it up).
 *
 * Re-provisioning is safe on every platform: container/deployment creation is
 * idempotent (an existing `devlet-<id>` resource is replaced) and the agent's
 * named volumes are reused, so workspace/home data survives.
 */
export async function recoverInterruptedProvisions(states: AgentState[], deps = {
  load: loadAgentState, save: saveAgentState, provision: provisionAgent,
}): Promise<void> {
  await Promise.all(states.filter(s => s.status === "provisioning").map(async snapshot => {
    try {
      const state = await deps.load(snapshot.config.id);
      if (state.status !== "provisioning") return;
      state.logs.push("[devlet] server restarted — resuming interrupted provisioning");
      await deps.save(state);
      try {
        const ref = await deps.provision(state.config, true);
        const latest = await deps.load(state.config.id);
        if (latest.status !== "provisioning") return;
        latest.platformRef = ref;
        latest.status = "running";
        delete latest.error;
        latest.logs.push("[devlet] interrupted provisioning recovered; runtime status will be reconciled");
        await deps.save(latest);
      } catch {
        const latest = await deps.load(state.config.id);
        if (latest.status !== "provisioning") return;
        latest.status = "error";
        // Provisioning exceptions can embed bootstrap scripts or credentials,
        // so keep the stored error generic and safe to surface in the UI.
        latest.error = "Interrupted provisioning could not be recovered. Retry the rebuild or recovery action.";
        latest.logs.push(`[devlet] ${latest.error}`);
        await deps.save(latest);
      }
    } catch {
      console.error(`[provision-recovery] could not recover provisioning state for ${snapshot.config.id}`);
    }
  }));
}
