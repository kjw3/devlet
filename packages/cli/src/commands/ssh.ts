import { trpc } from "../client.js";

export async function sshCommand(agentId: string) {
  let agent;
  try {
    agent = await trpc.agents.get.query(agentId);
  } catch {
    console.error(`error: agent "${agentId}" not found`);
    process.exit(1);
  }

  const ssh = agent.access?.ssh;
  if (!ssh) {
    console.error(`error: agent "${agent.config.name}" does not currently expose SSH`);
    process.exit(1);
  }

  console.log(`ssh ${ssh.username}@${ssh.host} -p ${ssh.port}`);
  if (ssh.hostKeyFingerprint) {
    console.log(`# host key ${ssh.hostKeyFingerprint}`);
  }
}
