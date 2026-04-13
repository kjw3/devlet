import { trpc } from "../client.js";
import { AGENT_TYPE_LABELS } from "@devlet/shared";

export async function statusCommand(agentId: string) {
  let agent;
  try {
    agent = await trpc.agents.get.query(agentId);
  } catch {
    console.error(`error: agent "${agentId}" not found`);
    process.exit(1);
  }

  const { config, status, missionProgress, platformRef, error } = agent;

  console.log(`\nagent: ${config.name} (${config.id})`);
  console.log(`─`.repeat(48));
  console.log(`type       ${AGENT_TYPE_LABELS[config.type]}`);
  console.log(`status     ${status}`);
  console.log(`platform   ${config.platform.type}`);
  console.log(`ref        ${platformRef || "(none)"}`);
  console.log(`role       ${config.role}`);
  console.log(`mission    ${config.mission.description}`);
  console.log(
    `progress   step ${missionProgress.currentStep + 1}/${config.mission.steps.length} (${missionProgress.completed.length} done)`
  );
  if (error) {
    console.log(`error      ${error}`);
  }
  if (agent.access?.ssh) {
    console.log(`ssh        ${agent.access.ssh.username}@${agent.access.ssh.host}:${agent.access.ssh.port}`);
  }
  console.log();
}
