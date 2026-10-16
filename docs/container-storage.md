# Container platform disk quotas

## Findings (2026-10-16)

Read-only Docker-info and filesystem probes via Komodo found:

- `docker1`, `docker2-dmz`, `miner1`, `sbx0`, `sbx1`, `sbx3`–`sbx7`,
  `spark-d8c8`: overlay2 with `Backing Filesystem=extfs`.
- `daw`, `docker3`, `gpu1`, `gpu2`, `pc4`: containerd overlayfs image store;
  visible Docker data-root filesystems are ext4.
- `pc3`, `sbx2`: containerd overlayfs; data-root filesystem not visible from
  the Periphery execution environment.
- Many Periphery environments cannot see `/var/lib/docker`. Running `df /`
  there would report the wrong filesystem and must not be used as host capacity.
- Separate local Docker and Portainer integrations were not configured in the
  inspected local environment; they have not been directly verified.

None of the inspected hosts establishes support for the conventional overlay2
XFS project-quota `--storage-opt size=` mechanism. Do not migrate Docker's data
root, remount filesystems, or enable privileged host access automatically.

## Policy (implemented)

`DEVLET_AGENT_DISK_MAX_GB=100` is the default hard ceiling for **new disk requests**.
The maximum is the lesser of this ceiling and free space minus safety reserve and
pending hires. This policy is separate from runtime enforcement: it does not
retroactively cap existing containers or make shared storage quota-capable.
An administrator can change it explicitly; values must be whole GB >= 10.
Templates larger than the ceiling are not silently admitted. Existing configs
remain readable and existing disks are not shrunk.

## Recommended implementation

Use one host-side storage service and one storage contract for Docker, Portainer,
and Komodo. Management platforms change the transport, not the quota semantics.
Do not call a workspace-only limit a total-container disk limit.

### 1. Read-only discovery

Return daemon identity, storage driver/snapshotter, data-root path, backing
filesystem, free bytes, mount/quota capabilities, and telemetry timestamp.
Resolve the daemon host rather than the server/Periphery container filesystem.
For Docker/Portainer obtain daemon metadata from Docker info and host filesystem
stats from an explicitly configured host helper. Komodo can use its terminal
transport when host visibility is verified; otherwise use the same helper.
Cache results briefly and deduplicate probes. Display free capacity independently
of quota support. Unreachable telemetry is unknown, not zero.

Pool identity must be stable across aliases: the same Docker daemon managed by
Portainer and Komodo shares reservations. Remote/shared filesystems also require
an explicit shared pool identity. Do not key solely by platform server ID.

### 2. Choose an enforceable storage backend

Preferred for the current ext4 hosts: an administrator-provisioned dedicated
agent-data mount backed by XFS project quotas (or an equivalent verified quota
backend). It need not replace Docker's existing data-root. An authenticated
host helper allocates a directory/project with a byte and inode limit, reports
capacity and usage, and releases it on explicit agent deletion.

Alternative for small lab deployments: a per-agent preallocated filesystem image,
formatted and mounted by the host helper. Preallocation gives a real capacity
reservation; a sparse file does not. This adds loop-device/mount lifecycle costs
and must be opt-in. No privileged containers, host mounts, filesystem formatting,
or daemon reconfiguration should happen without operator approval.

Native Docker writable-layer limits can be a separate backend on hosts where
support is verified (for example overlay2/XFS project quotas). Bind mounts and
volumes are outside that limit, so capability and scope must be explicit.

### 3. Make the agent filesystem contract enforceable

For a portable quota-backed data volume:

- Run the image root filesystem read-only.
- Bind `/workspace`, agent home/config/cache directories, and necessary writable
  application paths into subdirectories of the **same** quota-backed allocation.
- Audit each agent image and entrypoint: some currently write in `/opt`, `/tmp`,
  `/run`, or user homes. Provision ownership and seed required files before launch.
- Use bounded tmpfs for truly ephemeral paths and explicitly account for its RAM.
- Bound Docker log size/rotation separately. Logs and shared image layers are not
  charged to the agent-data quota; reserve capacity for them and report that scope.
- Never expose the Docker socket or quota-helper credentials inside agent containers.

Label the input **Agent data disk (GB)** for this backend, distinguishing it from
Proxmox's whole-guest disk. If writable root must remain enabled, a data-volume
quota alone is not sufficient: keep hard disk limits unavailable for that image.

### 4. Wire all three deployment adapters

- Docker: `HostConfig.Binds`/`Mounts`, `ReadonlyRootfs`, bounded `Tmpfs`, `LogConfig`;
  native backend uses `StorageOpt.size` only after verified capability.
- Portainer: identical Docker create payload through the endpoint proxy.
- Komodo: deployment volumes plus supported read-only/tmpfs/logging arguments;
  native backend uses `--storage-opt size=…` only after verified capability.

Allocate/reserve before container creation. Save allocation IDs durably. Roll back
failed launches without deleting retained task data. Restart/recovery reuses the
allocation; completed tasks retain it until explicit fire/delete. Reconcile orphan
allocations after crashes. Serialize admission with a host-side atomic reservation,
not just the Devlet process lock. Scope helper paths and operations to Devlet-owned
allocations; never accept arbitrary mount, device, or deletion paths from clients.

### 5. Verification and rollout

Use a disposable host/allocation first. Test all three adapters, both hire modes,
all enabled agent images, actual ENOSPC/EDQUOT at the boundary, inode exhaustion,
read-only root writes, log rotation, concurrent hires through different platform
aliases, restart recovery, retention, cleanup, unknown telemetry, and helper failure.
Verify the 100 GB ceiling and free-space bound server-side. Then opt in individual
hosts; unsupported hosts continue showing capacity and the reason quotas are
unavailable. Existing running agents are not migrated automatically.

## Next operator decision

Choose a disposable host and approve either a dedicated quota-enabled agent-data
mount or the opt-in filesystem-image backend. Host setup is the prerequisite for
real runtime enforcement on the inspected hosts; adding a Docker flag alone is not.
