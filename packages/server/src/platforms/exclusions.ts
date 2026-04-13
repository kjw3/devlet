import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import {
  PlatformExclusionsSchema,
  type PlatformExclusions,
} from "@devlet/shared";
import { config } from "../config.js";

const EXCLUSIONS_PATH = path.join(os.homedir(), ".devlet", "platform-exclusions.yaml");

function sortUnique(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort();
}

export async function loadStoredPlatformExclusions(): Promise<PlatformExclusions> {
  try {
    const raw = await fs.readFile(EXCLUSIONS_PATH, "utf8");
    return PlatformExclusionsSchema.parse(yaml.load(raw));
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : null;
    if (code === "ENOENT") {
      return { portainerEndpoints: [], proxmoxNodes: [] };
    }
    throw error;
  }
}

export async function saveStoredPlatformExclusions(exclusions: PlatformExclusions): Promise<void> {
  await fs.mkdir(path.dirname(EXCLUSIONS_PATH), { recursive: true });
  await fs.writeFile(
    EXCLUSIONS_PATH,
    yaml.dump({
      portainerEndpoints: sortUnique(exclusions.portainerEndpoints),
      proxmoxNodes: sortUnique(exclusions.proxmoxNodes),
    }),
    "utf8"
  );
}

export async function loadEffectivePlatformExclusions(): Promise<PlatformExclusions> {
  const stored = await loadStoredPlatformExclusions();
  return {
    portainerEndpoints: sortUnique([
      ...config.portainer.excludedEndpoints,
      ...stored.portainerEndpoints,
    ]),
    proxmoxNodes: sortUnique([
      ...config.proxmox.excludedNodes,
      ...stored.proxmoxNodes,
    ]),
  };
}

export async function setPortainerExcluded(target: string, excluded: boolean): Promise<PlatformExclusions> {
  const stored = await loadStoredPlatformExclusions();
  const next = new Set(stored.portainerEndpoints);
  if (excluded) {
    next.add(target);
  } else {
    next.delete(target);
  }

  const updated: PlatformExclusions = {
    ...stored,
    portainerEndpoints: sortUnique(next),
  };
  await saveStoredPlatformExclusions(updated);
  return loadEffectivePlatformExclusions();
}

export async function setProxmoxExcluded(target: string, excluded: boolean): Promise<PlatformExclusions> {
  const stored = await loadStoredPlatformExclusions();
  const next = new Set(stored.proxmoxNodes);
  if (excluded) {
    next.add(target);
  } else {
    next.delete(target);
  }

  const updated: PlatformExclusions = {
    ...stored,
    proxmoxNodes: sortUnique(next),
  };
  await saveStoredPlatformExclusions(updated);
  return loadEffectivePlatformExclusions();
}
