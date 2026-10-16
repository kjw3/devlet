# GPU agents

How GPU access is assigned to agents on each platform, what is implemented, and
how to verify it live.

## Current state

| Platform | Detection | Assignment at deploy | Status |
| --- | --- | --- | --- |
| Komodo | `nvidia-smi -L` on the server (host, or `--gpus all debian:12-slim` throwaway when the periphery agent is containerised) | `--gpus all` in the Deployment `extra_args` when `gpu.required` + container mode | Working — test target: `sbx3` (GeForce GT 1030) |
| Docker (local) | `docker info` `Runtimes.nvidia` + advertised `NVIDIA-GPU` GenericResources | `HostConfig.DeviceRequests` (`--gpus all`) on GPU-required hires | Implemented — test with a throwaway devlet on `sbx3` |
| Portainer | endpoint snapshot `Gpus` / Docker snapshot info | `HostConfig.DeviceRequests` on the endpoint's Docker API (same as Docker) | Implemented; stays hypothetical until a Portainer endpoint with a GPU exists |
| Proxmox | PCI device scan with free-GPU admission (BMC/dummy graphics excluded) | QEMU `hostpci0` passthrough via a root@pam token; the bootstrap installs `nvidia-container-toolkit` in the guest and runs the agent container with `--gpus all` | Device passthrough implemented; guest needs an NVIDIA-driver template (`PROXMOX_QEMU_GPU_TEMPLATE_ID`) — see the template recipe below |
| Agent image | — | — | New `devlet-agent-gpu` layer above the base image (see below) |

## The GPU image layer

`nvidia-container-toolkit` injects the **host's driver userland** (`libcuda.so.1`,
`nvidia-smi`) into any container it starts, so the stock base image already
reports GPUs under `--gpus all`. What it does not provide:

- explicit NVIDIA env (`NVIDIA_VISIBLE_DEVICES`, `NVIDIA_DRIVER_CAPABILITIES`) —
  behaviour should not depend on toolkit defaults
- CUDA runtime userland for binaries that do not bundle their own
  (`pip install torch` wheels bundle CUDA, so frameworks need nothing extra)
- a truthful one-line GPU status in the agent log

`packages/agents/Dockerfile.gpu` therefore builds `devlet-agent-gpu` on top of
`devlet-agent-base`: NVIDIA env, minimal CUDA userland (`cuda-cudart-12-4`,
~40 MB — the full `cuda-runtime` meta-package would add ~4 GB of cuBLAS/cuFFT
libs that framework wheels already provide), and a `devlet-gpu-check` probe the
entrypoint runs at startup (`[devlet] gpu: 1 device(s): NVIDIA GeForce GT 1030, ...`).

Selection happens in one place: `agentImageFor(agentConfig)` in
`packages/server/src/platforms/docker.ts`. When `gpu.required` is set on a
base coding agent (claude-code, codex, opencode, pi, gemini) it returns
`AGENT_IMAGE_GPU` (default `ghcr.io/kjw3/devlet-agent-gpu:latest`); gateway
agents keep their own images. Used by every deployer: Docker, Portainer,
Komodo, and the Proxmox guest bootstrap.

The image stays a separate tag (not baked into base) because CUDA userland
costs ~1–2 GB and non-GPU hosts should never pull it.

## Platform assignment

### Docker + Portainer (container passthrough)

GPU-required hires set `HostConfig.DeviceRequests` on the container create call
(the Engine-API equivalent of `docker run --gpus all`):

```json
{ "Driver": "nvidia", "Count": -1, "Capabilities": [["gpu", "compute", "utility"]] }
```

The host needs the NVIDIA driver + `nvidia-container-toolkit` (Docker's
`Runtimes.nvidia` is what marks an endpoint/server GPU-capable today).

### Komodo (container passthrough)

Already implemented: `--gpus all` is appended to the Deployment `extra_args`
when `gpu.required` and `passthroughMode !== "vm"`. Nothing to change beyond
image selection.

### Proxmox (VM passthrough)

GPU-required hires clone the QEMU template and set `hostpci0` to the node's
first free GPU (or `PROXMOX_GPU_PCI_ID`). Two guest-side requirements remain:

1. **The guest template needs the NVIDIA driver.** Passthrough hands the raw
   PCI device to the VM; without the driver inside the guest, `nvidia-smi`
   fails. Prepare a GPU QEMU template once (driver + Docker + qemu-guest-agent),
   then point `PROXMOX_QEMU_GPU_TEMPLATE_ID` at it.
2. **The bootstrap installs `nvidia-container-toolkit` in the guest** (added by
   this change) and starts the agent container with `--gpus all`, failing
   loudly if no NVIDIA device is visible (template without a driver).

#### GPU template recipe (one-time, per cluster)

```bash
# In the template VM (Debian 12/Ubuntu 22.04+), after Docker + qemu-guest-agent:
apt-get install -y build-essential linux-headers-$(uname -r)
# NVIDIA driver — from the distro repo or NVIDIA's .run file; noveau must be blacklisted
apt-get install -y nvidia-driver firmware-misc-nonfree   # Debian
nvidia-smi                                               # must list the GPU
# Reboot once, verify the module survives, then convert to a template.
```

Set `PROXMOX_QEMU_GPU_TEMPLATE_ID` to that template's ID. Devlet clones it for
GPU hires; the bootstrap handles the toolkit + `--gpus all`.

## Verification runbook

### Komodo — `sbx3` (GT 1030)

1. Confirm detection: hire preview shows `sbx3` as a GPU host with the GT 1030
   (first scan may take ~10–15 s while `debian:12-slim` is pulled).
2. Hire a GPU-required agent with placement override → Komodo → `sbx3`.
3. In the agent terminal: `nvidia-smi` must list the GT 1030; the startup log
   must contain the `[devlet] gpu:` line.
4. Optional smoke test: `python3 -c` with a small pip-installed torch tensor
   on `cuda:0` (2 GB VRAM — keep tensors tiny).

### Docker — throwaway devlet on `sbx3`

1. On `sbx3`: `git clone … && cp .env.example .env` (set `DEVLET_AUTH_TOKEN`),
   then `docker compose -f docker-compose.yml -f docker-compose.local-docker.yml up -d`.
2. Hire a GPU-required agent on the local Docker platform.
3. Verify: `docker inspect devlet-<id> --format '{{json .HostConfig.DeviceRequests}}'`
   is non-null, `nvidia-smi` works inside the container.

### Portainer

Hypothetical until an endpoint with a GPU is registered. The code path is
identical to Docker's (same Engine API create body); when a GPU endpoint
exists, repeat the Docker checks through Portainer.

### Proxmox

1. Stop the VM currently holding the GPU you want to free (`gpu1` or `gpu2`)
   so the PCI device becomes free again.
2. Confirm the hire preview offers the node, and the hire completes with
   `hostpci0` set (`qm config <vmid>`).
3. In the guest: `nvidia-smi` (template driver), then the agent container's
   `nvidia-smi` (toolkit + `--gpus all`).

## Per-GPU selection (hire wizard)

The hire wizard's GPU section lists the individual GPUs of the pinned host
(pinned = placement override; with auto-placement the scheduler picks the
host, then the least-loaded GPU on it). Leaving everything unchecked assigns
**one GPU — the least-claimed one on the chosen host** — and records it in the
agent config; claims are counted from active agents on the same host. Checking
specific GPUs restricts the agent to exactly those (check every GPU for the
legacy "all" behaviour). If the host's GPU inventory is unknown (probe
failed), the assignment falls back to "all".

- **Docker / Portainer / Komodo**: ids are NVIDIA UUIDs from `nvidia-smi -L`
  (Komodo probes its servers; Docker probes a throwaway `debian:12-slim
  --gpus all nvidia-smi -L` container; Portainer reads endpoint snapshots).
  Deployment requests exactly those GPUs (`--gpus device=UUID,…` on Komodo,
  `DeviceIDs` in HostConfig on Docker/Portainer). GPUs are *shared* on these
  platforms — two agents may select the same GPU.
- **Proxmox**: ids are PCI ids from `hardware/pci` with free/busy state from
  `hostpci*` ownership. Selection is *exclusive* — busy GPUs are rejected at
  hire time (including auto-assignment: a node whose every GPU is already
  passed through fails the hire instead of the VM start), and each selected
  GPU maps onto `hostpci0`–`hostpci3` (max 4).

Selections are re-validated against fresh probe data at hire time; a stale UI
selection fails with `PRECONDITION_FAILED` instead of deploying a broken agent.

## Limits / follow-ups

- **Scheduler VRAM awareness**: the wizard no longer asks for GPU memory —
  GPUs can't be fractionally assigned, so a user-settable VRAM figure was dead
  weight (`gpu.memoryMb` stays in the schema for stored configs; a future
  scheduler may match model VRAM automatically).
- **Full CUDA toolkit (nvcc)** is not in the GPU image — agents that need to
  compile CUDA should install `cuda-toolkit` in their workspace.
