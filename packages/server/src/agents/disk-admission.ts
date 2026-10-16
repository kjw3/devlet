import type { AgentState } from "@devlet/shared";
import { validateDisk } from "../platforms/disk.js";
import { saveAgentState } from "./state.js";
let admission: Promise<unknown> = Promise.resolve();
/** Serialize validation + persisted reservation within the single server process. */
export function admitAgent(state: AgentState, deps = { validate: validateDisk, save: saveAgentState }): Promise<void> {
  const job = admission.catch(() => {}).then(async () => {
    const storageMb = await deps.validate(state.config.platform, state.config.resources.storageMb);
    if (storageMb !== undefined) state.config.resources.storageMb = storageMb;
    await deps.save(state);
  });
  admission = job;
  return job;
}
