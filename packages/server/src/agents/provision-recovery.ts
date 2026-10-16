import type { AgentState } from "@devlet/shared";
import { provisionAgent } from "../platforms/dispatch.js";
import { loadAgentState, saveAgentState } from "./state.js";

/** Only the startup snapshot is recovered; new hires have their own live jobs. */
export async function recoverInterruptedProvisions(states: AgentState[], deps = {
  load: loadAgentState, save: saveAgentState, provision: provisionAgent,
}): Promise<void> {
  await Promise.all(states.filter(s => s.status === "provisioning" && s.config.platform.type === "proxmox").map(async snapshot => {
    try {
      const state = await deps.load(snapshot.config.id);
      if (state.status !== "provisioning") return;
      state.logs.push("[devlet] server restarted — resuming interrupted Proxmox provisioning");
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
        // SSH exceptions can embed the bootstrap script and its credentials.
        latest.error = "Interrupted Proxmox provisioning could not be recovered. Guest retained; inspect the guest and retry recovery.";
        latest.logs.push(`[devlet] ${latest.error}`);
        await deps.save(latest);
      }
    } catch {
      console.error(`[proxmox] could not recover provisioning state for ${snapshot.config.id}`);
    }
  }));
}
