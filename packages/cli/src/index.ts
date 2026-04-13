#!/usr/bin/env node
import { Command } from "commander";
import { listCommand } from "./commands/list.js";
import { hireCommand } from "./commands/hire.js";
import { fireCommand } from "./commands/fire.js";
import { statusCommand } from "./commands/status.js";
import { logsCommand } from "./commands/logs.js";
import { modelsListCommand, modelsSetDefaultCommand } from "./commands/models.js";
import { platformsSetExcludedCommand, platformsStatusCommand } from "./commands/platforms.js";

const program = new Command();

program
  .name("devlet")
  .description("AI agent orchestration — hire, fire, and manage agents")
  .version("0.1.0");

program
  .command("list")
  .alias("ls")
  .description("List all agents")
  .action(listCommand);

program
  .command("hire")
  .description("Hire a new agent (interactive wizard)")
  .action(hireCommand);

program
  .command("fire <agent-id>")
  .description("Fire (terminate) an agent")
  .option("-f, --force", "skip confirmation prompt")
  .action((id: string, opts: { force?: boolean }) => fireCommand(id, opts));

program
  .command("status <agent-id>")
  .description("Show agent status and mission progress")
  .action(statusCommand);

program
  .command("logs <agent-id>")
  .description("Tail agent logs")
  .action(logsCommand);

const modelsCmd = program
  .command("models")
  .description("Manage default model configuration");

modelsCmd
  .command("list")
  .description("List providers and their configured default models")
  .action(modelsListCommand);

modelsCmd
  .command("set-default <provider> <model>")
  .description("Set the default model for a provider (e.g. anthropic claude-sonnet-4-6)")
  .action((provider: string, model: string) => modelsSetDefaultCommand(provider, model));

const platformsCmd = program
  .command("platforms")
  .description("Inspect and manage platform scheduling state");

platformsCmd
  .command("status")
  .description("Show schedulable and excluded Portainer endpoints / Proxmox nodes")
  .action(platformsStatusCommand);

platformsCmd
  .command("exclude <platform> <target>")
  .description("Exclude a Portainer endpoint or Proxmox node from scheduling")
  .action((platform: "portainer" | "proxmox", target: string) =>
    platformsSetExcludedCommand(platform, target, true)
  );

platformsCmd
  .command("include <platform> <target>")
  .description("Re-include a Portainer endpoint or Proxmox node in scheduling")
  .action((platform: "portainer" | "proxmox", target: string) =>
    platformsSetExcludedCommand(platform, target, false)
  );

program.parse();
