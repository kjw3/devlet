import { trpc } from "../client.js";

export async function fireCommand(agentId: string, opts: { force?: boolean }) {
  if (!opts.force) {
    const { confirm } = await import("@clack/prompts");
    const ok = await confirm({
      message: `Fire agent ${agentId}? Container will be destroyed.`,
    });
    if (!ok) {
      console.log("cancelled");
      return;
    }
  }

  try {
    await trpc.agents.fire.mutate(agentId);
    console.log(`fired: ${agentId}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    process.exit(1);
  }
}
