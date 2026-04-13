import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

export interface AgentSshMaterial {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}

export function isAgentSshEnabled(): boolean {
  return config.agentSsh.authorizedKeys.length > 0;
}

export function getAgentSshAuthorizedKeys(): string {
  return config.agentSsh.authorizedKeys.join("\n");
}

export async function generateAgentSshMaterial(agentId: string): Promise<AgentSshMaterial> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `devlet-ssh-${agentId}-`));
  const keyPath = path.join(tempDir, "ssh_host_ed25519_key");

  try {
    await execFileAsync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      `devlet-${agentId}`,
      "-f",
      keyPath,
    ]);

    const [privateKey, publicKey, fingerprintOutput] = await Promise.all([
      fs.readFile(keyPath, "utf8"),
      fs.readFile(`${keyPath}.pub`, "utf8"),
      execFileAsync("ssh-keygen", ["-lf", `${keyPath}.pub`, "-E", "sha256"]),
    ]);

    const fingerprint = fingerprintOutput.stdout.trim().split(/\s+/)[1] ?? "";
    if (!fingerprint) {
      throw new Error("Failed to determine SSH host key fingerprint");
    }

    return {
      privateKey,
      publicKey,
      fingerprint,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
