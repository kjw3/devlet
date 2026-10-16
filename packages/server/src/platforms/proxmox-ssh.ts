import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── Provisioning keypair (D2) ─────────────────────────────────────────────────
// The PVE API cannot execute commands inside guests, so Devlet reaches them over
// SSH. A single dedicated keypair is generated once and stored on disk; its
// public half is injected into LXC guests at create time and is expected in the
// QEMU template (or its cloud-init config, which the deployer sets on clone).

export interface ProvisioningKeyMaterial {
  privateKeyPath: string;
  publicKey: string;
}

const KEY_PATH = path.join(os.homedir(), ".devlet", "proxmox-provision-key");
const KEY_PATH_PUB = `${KEY_PATH}.pub`;

export async function getProvisioningKey(): Promise<ProvisioningKeyMaterial> {
  await fs.mkdir(path.dirname(KEY_PATH), { recursive: true });

  const [privateKeyExists, publicKeyExists] = await Promise.all([
    fs
      .access(KEY_PATH)
      .then(() => true)
      .catch(() => false),
    fs
      .access(KEY_PATH_PUB)
      .then(() => true)
      .catch(() => false),
  ]);

  if (!privateKeyExists || !publicKeyExists) {
    await execFileAsync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "devlet-proxmox-provisioning",
      "-f",
      KEY_PATH,
    ]);
    await fs.chmod(KEY_PATH, 0o600);
  }

  const publicKey = (await fs.readFile(KEY_PATH_PUB, "utf8")).trim();
  if (!publicKey) {
    throw new Error(`Proxmox provisioning public key at ${KEY_PATH_PUB} is empty`);
  }
  return { privateKeyPath: KEY_PATH, publicKey };
}

// ─── Remote command execution ──────────────────────────────────────────────────

export class SshCommandError extends Error {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string
  ) {
    super(message);
    this.name = "SshCommandError";
  }
}

/**
 * Run a bash script on the guest as root over SSH. The script is base64-encoded
 * into the remote command line, so no stdin plumbing or shell quoting issues —
 * arbitrary bytes survive the trip.
 */
export async function runGuestScript(
  ip: string,
  script: string,
  opts: { timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  const key = await getProvisioningKey();
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const remote = `echo ${encoded} | base64 -d | bash`;

  try {
    return await execFileAsync(
      "ssh",
      [
        "-i",
        key.privateKeyPath,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "LogLevel=ERROR",
        "-o",
        `ConnectTimeout=10`,
        `root@${ip}`,
        remote,
      ],
      {
        timeout: opts.timeoutMs ?? 10 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
      }
    );
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (e.killed) {
      throw new SshCommandError(`Guest command timed out on ${ip}`, e.stdout ?? "", e.stderr ?? "");
    }
    throw new SshCommandError(
      `Guest command failed on ${ip}: ${e.message ?? "unknown error"}`,
      e.stdout ?? "",
      e.stderr ?? ""
    );
  }
}

/** Quick reachability probe: run `true` on the guest with a short deadline. */
export async function isGuestSshReachable(ip: string, timeoutMs = 5000): Promise<boolean> {
  try {
    await runGuestScript(ip, "true", { timeoutMs });
    return true;
  } catch {
    return false;
  }
}
