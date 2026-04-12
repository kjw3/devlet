import { trpc } from "../client.js";

export async function logsCommand(agentId: string) {
  let logs;
  try {
    logs = await trpc.agents.logs.query(agentId);
  } catch {
    console.error(`error: agent "${agentId}" not found`);
    process.exit(1);
  }

  if (logs.length === 0) {
    console.log("(no logs)");
    return;
  }

  for (const line of logs) {
    console.log(line);
  }
}
