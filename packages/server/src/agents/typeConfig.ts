import yaml from "js-yaml";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { AgentTypeConfigMap } from "@devlet/shared";

const CONFIG_PATH = path.join(os.homedir(), ".devlet", "agent-type-config.yaml");

export async function loadAgentTypeConfig(): Promise<AgentTypeConfigMap> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = yaml.load(raw) as AgentTypeConfigMap | null;
    return parsed ?? { configs: {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { configs: {} };
    throw err;
  }
}

export async function saveAgentTypeConfig(config: AgentTypeConfigMap): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, yaml.dump(config), "utf8");
}
