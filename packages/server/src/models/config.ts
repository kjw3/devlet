import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { ModelDefaultsSchema, type ModelDefaults } from "@devlet/shared";

export const MODEL_CONFIG_PATH = path.join(os.homedir(), ".devlet", "model-config.yaml");

export async function loadModelDefaults(): Promise<ModelDefaults> {
  try {
    const content = await fs.readFile(MODEL_CONFIG_PATH, "utf8");
    return ModelDefaultsSchema.parse(yaml.load(content));
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : null;
    if (code === "ENOENT") {
      return { defaults: {} };
    }
    throw error;
  }
}

export async function saveModelDefaults(defaults: ModelDefaults): Promise<void> {
  await fs.mkdir(path.dirname(MODEL_CONFIG_PATH), { recursive: true });
  await fs.writeFile(MODEL_CONFIG_PATH, yaml.dump(defaults), "utf8");
}
