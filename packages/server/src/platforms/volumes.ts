/**
 * Named-volume conventions for agent persistence.
 *
 * Each agent gets two named volumes so its data survives stop/start AND full
 * reprovision (rebuild):
 *   - `devlet-{id}-workspace` → /workspace  (the agent's project files)
 *   - `devlet-{id}-home`      → /home/agent (tool configs, ~/.devlet manifest,
 *                                   agent harness state)
 *
 * Docker auto-copies the image's initial content into a named volume the first
 * time it is mounted on an empty volume, so a fresh provision still gets the
 * image's default files, and subsequent provisions reuse the existing data.
 */

export const WORKSPACE_PATH = "/workspace";
export const HOME_PATH = "/home/agent";

export function workspaceVolumeName(agentId: string): string {
  return `devlet-${agentId}-workspace`;
}

export function homeVolumeName(agentId: string): string {
  return `devlet-${agentId}-home`;
}

/** All named volumes an agent owns, in mount order. */
export function agentVolumeNames(agentId: string): string[] {
  return [workspaceVolumeName(agentId), homeVolumeName(agentId)];
}

/**
 * `docker run`-style volume spec `volumeName:containerPath` for each of the
 * agent's named volumes. Shared by every platform adapter so the mount layout
 * is identical regardless of backend.
 */
export function agentVolumeMounts(agentId: string): string[] {
  return [
    `${workspaceVolumeName(agentId)}:${WORKSPACE_PATH}`,
    `${homeVolumeName(agentId)}:${HOME_PATH}`,
  ];
}
