# GPU agents

How GPU access is assigned to agents on each platform, what is implemented, and
how to verify it live.

## Current state

| Platform | Detection | Assignment at deploy | Status |
| --- | --- | --- | --- |
| Komodo | `nvidia-smi -L` on the server (host, or `--gpus all debian:12-slim` throwaway when the periphery agent is containerised) | `--gpus all` in the Deployment `extra_args` when `gpu.required` + container mode | Working — test target: `sbx3` (GeForce GT 1030) |
| Docker (local) | `docker info` `Runtimes.nvidia` + advertised `NVIDIA-GPU` GenericResources | `HostConfig.DeviceRequests` (`--gpus all`) on GPU-required hires | Implemented — test with a throwaway devlet on `sbx3` |
| Portainer | endpoint snapshot `Gpus` / Docker snapshot info | `HostConfig.DeviceRequests` on the endpoint's Docker API (same as Docker) | Implemented; stays hypothetical until a Portainer endpoint with a GPU exists |
| Proxmox | PCI device scan with free-GPU admission (BMC/dummy graphics excluded); GPU hires rejected at hire time when neither a PCI mapping nor a root token covers the node's GPU | QEMU `hostpci0` passthrough. PVE refuses **unmapped** `hostpci*` config to every API-token identity — even tokens of `root@pam` ("only root can set 'hostpci0' config for non-mapped devices"). The supported path is a **PCI resource mapping**: Datacenter → Resource Mappings → PCI → Add (map the node + GPU PCI id, e.g. `pc2:0000:02:00.0`); the deploy then writes `hostpci0=mapping=<name>,pcie=1`, which the regular `aiagent` token may set given `Resource.Use` on the mapping (Administrator covers it). A root@pam token (`PROXMOX_ROOT_USER`/`PROXMOX_ROOT_TOKEN_ID`/`PROXMOX_ROOT_TOKEN_SECRET`) is only a fallback when the mapping exists but the regular token lacks `Resource.Use`. The bootstrap installs `nvidia-container-toolkit` in the guest and runs the agent container with `--gpus all` | Device passthrough implemented; guest needs an NVIDIA-driver template (`PROXMOX_QEMU_GPU_TEMPLATE_ID`) — see the template recipe below |
| Agent image | — | — | New `devlet-agent-gpu` layer above the base image (see below) |

## The GPU image layer

`nvidia-container-toolkit` injects the **host's driver userland** (`libcuda.so.1`,
`nvidia-smi`) into any container it starts, so the stock base image already
reports GPUs under `--gpus all`. What it does not provide:

- explicit NVIDIA env (`NVIDIA_VISIBLE_DEVICES`, `NVIDIA_DRIVER_CAPABILITIES`) —
  behaviour should not depend on toolkit defaults
- CUDA runtime userland for binaries that do not bundle their own
- a truthful one-line GPU status in the agent log, **plus a data-plane probe**
- a compute stack so the GPU is useful out of the box (see below)

`packages/agents/Dockerfile.gpu` therefore builds `devlet-agent-gpu` on top of
`devlet-agent-base`: NVIDIA env, minimal CUDA userland (`cuda-cudart-12-4`,
~40 MB), and a `devlet-gpu-check` probe the entrypoint runs at startup
(`[devlet] gpu: 1 device(s): NVIDIA GeForce GT 1030, ...`).

### Compute stack (x86_64)

On x86_64 the GPU image additionally ships (adds ~4.5 GB — GPU hosts only):

- **PyTorch 2.4.1 + cu124 wheels and numpy < 2** — validated end-to-end on the
  GT 1030 (sm_61/Pascal): `torch.cuda.is_available()`, 1000×1000 GPU matmul.
  The wheels bundle their own CUDA libraries; the host driver (580.x, CUDA 13)
  runs them fine. `TORCH_CUDA_ARCH_LIST="6.1"` keeps any source-built
  extensions Pascal-only. numpy is pinned <2 because torch 2.4.1 predates the
  numpy 2.0 ABI.
- **nvcc/ptxas + CUDA headers (`cuda-nvcc-12-4`, `cuda-cudart-dev-12-4`) and
  build-essential** — so the agent can compile raw CUDA kernels
  (`nvcc -arch=sm_61`) without installing anything. Compilation needs no GPU;
  the driver's JIT runs PTX from any CUDA version ≤ the host driver's.
- **`devlet-cuda-probe`** — a zero-dependency ctypes probe run by
  `devlet-gpu-check` after the management-plane line. Verifies the data plane
  (primary-context retention, allocation, H2D/D2H roundtrip, device writes,
  and a driver-JIT'd PTX kernel) and logs `[devlet] gpu: compute OK` — or the
  failing stage. Never blocks startup.
- **GPU facts as env** (`DEVLET_GPU_NAME`, `DEVLET_GPU_UUID`,
  `DEVLET_GPU_COUNT`, `DEVLET_GPU_TOTAL_MEMORY_MB`, `DEVLET_GPU_COMPUTE_CAP`),
  exported by the entrypoint so the agent can budget VRAM / pick batch sizes
  without re-probing. Read-only facts — never touches
  `CUDA_VISIBLE_DEVICES` (the toolkit sets it from the `--gpus device=`
  selection).

> **Troubleshooting note** — raw-driver (ctypes) CUDA code that calls
> `cuMemAlloc` right after `cuInit` fails with `CUDA_ERROR_INVALID_CONTEXT`
> (201) even on a perfectly working GPU: a current context must exist first
> (`cuDevicePrimaryCtxRetain` + `cuCtxSetCurrent`, or `cuCtxCreate`). A
> healthy GPU once looked broken because of exactly this; `devlet-cuda-probe`
> documents the correct sequence.

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
# NVIDIA driver — from the distro repo or NVIDIA's .run file; noveau must be blacklisted.
# Driver must be >= 550 for the CUDA 12.4 stack baked into devlet-agent-gpu
# (validated on 580.178.04); Debian 12 needs bookworm-backports for that.
apt-get install -y nvidia-driver firmware-misc-nonfree   # Debian
# Load the CUDA data-plane module at boot — nvidia-smi works without it, but
# every container allocation fails if it is missing in a cloned guest.
echo nvidia-uvm > /etc/modules-load.d/nvidia-uvm.conf
nvidia-smi                                               # must list the GPU
# Reboot once, verify the module survives (lsmod | grep nvidia_uvm), then
# convert to a template.
```

Set `PROXMOX_QEMU_GPU_TEMPLATE_ID` to that template's ID. Devlet clones it for
GPU hires; the bootstrap handles the toolkit + `--gpus all` (and best-effort
`modprobe nvidia_uvm`).

No template rebuild is needed for compute-stack updates (PyTorch, nvcc, the
probes): those live in the `devlet-agent-gpu` image and are pulled per hire.
The template only owns the kernel driver. GPU QEMU hires require a **32 GB
disk minimum** (the GPU image is ~8.5 GB and the pull+unpack peak is ~13 GB
in `/var/lib/docker`); the hire wizard enforces this automatically.

## Verification runbook

### Komodo — `sbx3` (GT 1030)

1. Confirm detection: hire preview shows `sbx3` as a GPU host with the GT 1030
   (first scan may take ~10–15 s while `debian:12-slim` is pulled).
2. Hire a GPU-required agent with placement override → Komodo → `sbx3`.
3. In the agent terminal: `nvidia-smi` must list the GT 1030; the startup log
   must contain the `[devlet] gpu:` line followed by
   `[devlet] gpu: compute OK (context, alloc, copy, JIT kernel)`.
4. Smoke test (torch is baked into the GPU image; 2 GB VRAM — keep tensors
   tiny): `python3 -c "import torch; x=torch.randn(1000,1000,device='cuda'); print(torch.cuda.get_device_name(0), float((x@x).sum()))"`.

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
3. In the guest: `nvidia-smi` (template driver) and `lsmod | grep nvidia_uvm`
   (data-plane module; the bootstrap also loads it best-effort), then the
   agent container's `nvidia-smi` (toolkit + `--gpus all`).
4. The agent startup log must show `[devlet] gpu: compute OK (context, alloc,
   copy, JIT kernel)` — identical to the Komodo check, since the same image
   runs inside the guest.

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
  "Busy" means the device appears in any VM's `hostpci*` config — **even when
  the holding VM is stopped** (starting it later would conflict). To free a
  GPU, remove the passthrough from the holding VM (`qm set <vmid> --delete
  hostpci0` on the node); the scheduler then sees it as free. The scheduler
  and the placement preview count only *free* GPUs for GPU-required hires —
  a fully-claimed node is skipped rather than recommended-and-rejected.

Selections are re-validated against fresh probe data at hire time; a stale UI
selection fails with `PRECONDITION_FAILED` instead of deploying a broken agent.

## Limits / follow-ups

- **Scheduler VRAM awareness**: the wizard no longer asks for GPU memory —
  GPUs can't be fractionally assigned, so a user-settable VRAM figure was dead
  weight (`gpu.memoryMb` stays in the schema for stored configs; a future
  scheduler may match model VRAM automatically).
- **Small-VRAM ergonomics**: the fleet's desktop parts (GT 1030, 2 GB) can't
  fit large models. Agents should read `DEVLET_GPU_TOTAL_MEMORY_MB`/
  `torch.cuda.get_device_properties(0).total_memory` up front, default to
  small batches and fp16/int8, and prefer CPU fallback over OOM. Pascal
  (sm_61) support must be checked before bumping torch/CUDA — recent
  toolchains keep dropping old architectures (CUDA 12.4 + torch 2.4 is the
  validated floor).
