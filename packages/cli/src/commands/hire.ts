import * as p from "@clack/prompts";
import { trpc } from "../client.js";
import {
  AGENT_TYPES,
  AGENT_TYPE_LABELS,
  DEFAULT_RESOURCE_LIMITS,
} from "@devlet/shared";

export async function hireCommand() {
  p.intro("devlet hire — agent onboarding wizard");

  const agentType = await p.select({
    message: "Agent type",
    options: AGENT_TYPES.map((t) => ({
      value: t,
      label: AGENT_TYPE_LABELS[t],
    })),
  });
  if (p.isCancel(agentType)) { p.cancel("cancelled"); return; }

  const platform = await p.select({
    message: "Deployment platform",
    options: [
      { value: "docker", label: "Docker (local)" },
      { value: "portainer", label: "Portainer" },
      { value: "proxmox", label: "Proxmox" },
    ],
  });
  if (p.isCancel(platform)) { p.cancel("cancelled"); return; }

  const name = await p.text({
    message: "Agent name",
    placeholder: "e.g. PR Reviewer",
    validate: (v) => (v.trim() ? undefined : "required"),
  });
  if (p.isCancel(name)) { p.cancel("cancelled"); return; }

  const role = await p.text({
    message: "Role description",
    placeholder: "e.g. Senior code reviewer specializing in TypeScript",
    validate: (v) => (v.trim() ? undefined : "required"),
  });
  if (p.isCancel(role)) { p.cancel("cancelled"); return; }

  const missionDescription = await p.text({
    message: "Mission objective",
    placeholder: "Describe what this agent should accomplish...",
    validate: (v) => (v.trim() ? undefined : "required"),
  });
  if (p.isCancel(missionDescription)) { p.cancel("cancelled"); return; }

  const onComplete = await p.select({
    message: "On mission complete",
    options: [
      { value: "idle", label: "idle — keep running" },
      { value: "terminate", label: "terminate — self-destruct" },
      { value: "report", label: "report — generate summary" },
    ],
  });
  if (p.isCancel(onComplete)) { p.cancel("cancelled"); return; }

  const s = p.spinner();
  s.start("Hiring agent...");

  try {
    const now = new Date().toISOString();
    const agent = await trpc.agents.hire.mutate({
      name: name as string,
      type: agentType as typeof AGENT_TYPES[number],
      role: role as string,
      mission: {
        description: missionDescription as string,
        steps: [],
        onComplete: onComplete as "idle" | "terminate" | "report",
      },
      platformOverride:
        platform === "docker"
          ? { type: "docker" as const }
          : platform === "portainer"
          ? { type: "portainer" as const, endpointId: 1 }
          : { type: "proxmox" as const, node: "pve-01", vmType: "lxc" as const },
      resources: DEFAULT_RESOURCE_LIMITS,
      env: {},
      persistent: true,
    });

    s.stop(`Agent hired: ${agent.config.id}`);
    p.outro(`${agent.config.name} is ${agent.status} on ${agent.config.platform.type}`);
  } catch (err: unknown) {
    s.stop("failed");
    const msg = err instanceof Error ? err.message : String(err);
    p.cancel(`error: ${msg}`);
    process.exit(1);
  }
}
