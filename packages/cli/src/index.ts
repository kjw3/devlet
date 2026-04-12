#!/usr/bin/env node
import { Command } from "commander";
import { listCommand } from "./commands/list.js";
import { hireCommand } from "./commands/hire.js";
import { fireCommand } from "./commands/fire.js";
import { statusCommand } from "./commands/status.js";
import { logsCommand } from "./commands/logs.js";

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

program.parse();
