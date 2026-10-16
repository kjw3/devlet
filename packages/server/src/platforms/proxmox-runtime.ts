import { runGuestScript } from "./proxmox-ssh.js";

/** Missing is distinct so recovery can bootstrap without destroying an existing workspace. */
export async function inspectGuestRuntime(
  ip: string,
  run: typeof runGuestScript = runGuestScript
): Promise<boolean | "missing" | null> {
  try {
    // Unlike `inspect ... || true`, this never mistakes a Docker daemon failure
    // for an absent container. A successful empty listing means it is missing.
    const { stdout } = await run(ip,
      "docker container ls -a --filter 'name=^/devlet-agent$' --format '{{.State}}'",
      { timeoutMs: 10_000 });
    switch (stdout.trim()) {
      case "": return "missing";
      case "running":
      case "restarting": return true;
      case "exited":
      case "dead":
      case "created": return false;
      default: return null; // paused, removing, or an unexpected response
    }
  } catch {
    return null; // SSH timeout or Docker failure is not proof of task completion
  }
}
