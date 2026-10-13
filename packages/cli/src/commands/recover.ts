import { trpc } from "../client.js";

export async function recoverCommand(agentId: string) {
  try {
    const agent = await trpc.agents.recover.mutate({ agentId });
    console.log(`recovered: ${agent.config.id}`);
    console.log(`platform: ${agent.config.platform.type}`);
    console.log(`status: ${agent.status}`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
