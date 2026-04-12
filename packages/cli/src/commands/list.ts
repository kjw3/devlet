import { trpc } from "../client.js";
import { STATUS_COLORS, AGENT_TYPE_LABELS } from "@devlet/shared";

const STATUS_SYMBOLS: Record<string, string> = {
  provisioning: "◐",
  bootstrapping: "◑",
  running: "●",
  idle: "○",
  terminated: "✕",
  error: "!",
};

export async function listCommand() {
  let agents;
  try {
    agents = await trpc.agents.list.query();
  } catch {
    console.error("error: cannot connect to devlet server (is it running?)");
    process.exit(1);
  }

  if (agents.length === 0) {
    console.log("no agents running");
    return;
  }

  const header = [
    "ID".padEnd(12),
    "NAME".padEnd(20),
    "TYPE".padEnd(14),
    "STATUS".padEnd(14),
    "PLATFORM".padEnd(10),
    "MISSION",
  ].join("  ");

  console.log(header);
  console.log("─".repeat(header.length));

  for (const agent of agents) {
    const sym = STATUS_SYMBOLS[agent.status] ?? "?";
    const row = [
      agent.config.id.padEnd(12),
      agent.config.name.slice(0, 18).padEnd(20),
      AGENT_TYPE_LABELS[agent.config.type].padEnd(14),
      `${sym} ${agent.status}`.padEnd(14),
      agent.config.platform.type.padEnd(10),
      agent.config.mission.description.slice(0, 48),
    ].join("  ");
    console.log(row);
  }
}
