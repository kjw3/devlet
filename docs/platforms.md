# Platform notes

GPU assignment per platform is covered in [docs/gpu-agents.md](gpu-agents.md):
gpu-required coding agents run the `devlet-agent-gpu` image (NVIDIA env + CUDA
runtime layered on the base image), container platforms request GPUs via
`HostConfig.DeviceRequests` (`--gpus all`), and Proxmox passes the PCI device
through to a QEMU guest.

## Komodo

Devlet places agents on Komodo servers through the Komodo API and needs to know two things about
each server that Komodo does not reliably report: **how to reach it** and **whether it has an
NVIDIA GPU**. Many Komodo agents ("periphery") run inside a container, where Komodo's own terminal
only sees the container. Devlet handles this automatically.

### Reachable host address

Used for the agent web-terminal proxy and the direct `ssh agent@<host> -p <port>` command. Resolved
in this order:

1. `KOMODO_SERVER_HOSTS` — explicit `name=host` override (comma-separated).
2. The address Komodo reports for the server (`external_address` / `address`).
3. **The LAN address detected on the server itself** — Devlet runs `ip -4 route get 1.1.1.1` on it.
   If the Komodo agent is containerised, it runs the same command in a throwaway
   `docker run --rm --net=host busybox:1.37 …` so it reads the real host network. The result is
   cached for an hour.
4. A dotted server name (assumed to be an FQDN).
5. Komodo's public IP — usually a shared WAN address and rarely what you want.

You normally do not need `KOMODO_SERVER_HOSTS` any more. Set it only when detection picks an address
the Devlet server cannot reach. If an agent's host address is unreachable but the agent is on your
tailnet and the Devlet server is too, the proxy falls back to the tailnet automatically
([docs/tailscale.md](tailscale.md)).

### GPU detection

A server is tagged as a GPU node when `nvidia-smi -L` lists a device:

- If the Komodo agent runs on the host, `nvidia-smi` is run directly.
- If it runs in a container and Docker has an NVIDIA runtime, Devlet runs
  `docker run --rm --gpus all debian:12-slim nvidia-smi -L` (the NVIDIA container toolkit injects
  `nvidia-smi`). Servers without an NVIDIA runtime are skipped, so nothing is pulled needlessly.

Results are cached for five minutes. The first scan after a Devlet restart can take ~10–15 seconds
while `busybox` / `debian:12-slim` are pulled onto the hosts that need them.

GPU-required agents are deployed with `--gpus all` (container passthrough) and the
`devlet-agent-gpu` image; the target server needs the NVIDIA driver and
`nvidia-container-toolkit`.

## Portainer

Endpoints are discovered from the Portainer API. Agent ports are published on `0.0.0.0` of the
endpoint's Docker host and reached through the endpoint's address. GPU-required agents set
`HostConfig.DeviceRequests` on the endpoint's Docker API (identical to the local Docker
platform); endpoint hosts need the NVIDIA driver + `nvidia-container-toolkit`.

## Docker (local)

Opt-in: add `docker-compose.local-docker.yml` to mount the host Docker socket into the Devlet server
(omit it on a production control plane that places agents through Komodo or Portainer). Agents then run on that socket. Published ports bind to loopback on
the Docker host and the server proxies to them via `DEVLET_DOCKER_PROXY_HOST`
(default `host.docker.internal`). GPU-required agents request all NVIDIA GPUs via
`HostConfig.DeviceRequests` (`--gpus all`); the host needs the NVIDIA driver +
`nvidia-container-toolkit`.

## Proxmox

Full deployment platform (see [docs/proxmox-provisioning.md](proxmox-provisioning.md) for the
implementation plan, permissions and template preparation):

- **One guest per agent.** LXC for CPU agents, QEMU clones for VM/GPU agents
  (nanoclaw and GPU-required hires route here). The guest runs Docker and the standard
  agent image, so agent behaviour is identical to the container platforms. Guests use
  DHCP on `PROXMOX_BRIDGE` (default vmbr0) — the bridge needs a DHCP server.
- **Requirements:** `PROXMOX_LXC_TEMPLATE` (an LXC OS template in `PROXMOX_STORAGE`,
  Debian-based) and, for VM agents, `PROXMOX_QEMU_TEMPLATE_ID` (a template VM with
  Docker + qemu-guest-agent installed; cloud-init templates get the provisioning key
  injected automatically). Missing templates fail the hire synchronously with a clear
  error.
- **Disks.** LXC rootfs goes to `PROXMOX_STORAGE` (default `local-lvm` — node-local and
  fast; use a shared storage like Ceph if you want guest mobility). VM disks go to
  `PROXMOX_QEMU_STORAGE` (default: the template's own storage when shared). Clones are
  **linked** (instant, copy-on-write) when the destination equals the template's disk
  storage — put the QEMU template on shared storage (e.g. `ceph-vms`) to get linked
  clones on every node; otherwise Devlet full-clones (a one-time disk copy per agent).
- **Fixed ports.** Each agent has its own guest, so ports never collide: terminal 7681,
  SSH 2222, plus OpenClaw 18789 / Moltis 13131 where applicable.
- **GPU passthrough.** GPU-required hires get the node's first **free** GPU as
  `hostpci0` — GPUs already passed through to another VM are rejected up front (hire
  fails synchronously with `Node "x" has no free GPU`; override with
  `PROXMOX_GPU_PCI_ID`, BMC/dummy graphics excluded). PVE only lets root@pam set
  `hostpci*` — even a fully-privileged token gets `only root can set 'hostpci0' config`
  — so GPU hires need an optional root token
  (`PROXMOX_ROOT_USER`/`PROXMOX_ROOT_TOKEN_ID`/`PROXMOX_ROOT_TOKEN_SECRET`, created via
  `pveum user token add root@pam devlet-gpu --privsep 0`). It is used solely for that
  config step; all other calls stay least-privileged. The hosts also need IOMMU enabled
  (`intel_iommu=on`/`amd_iommu=on` + `iommu=pt`, vfio modules). The guest itself needs
  the NVIDIA driver — use a GPU QEMU template (`PROXMOX_QEMU_GPU_TEMPLATE_ID`, recipe in
  [docs/gpu-agents.md](gpu-agents.md)); the bootstrap installs
  `nvidia-container-toolkit` in the guest and starts the agent container with
  `--gpus all`, failing clearly when the guest has no usable GPU.
- **Access.** The terminal proxy and SSH commands target the guest's IP (LXC interfaces
  API / qemu-guest-agent), with the same automatic tailnet fallback as Komodo agents.
- **Lifecycle.** Fire destroys the guest; persistent agents are restarted by the
  reconciler when stopped out-of-band; logs come from `docker logs` inside the guest.

Run `node --import tsx scripts/proxmox-probe.ts` from `packages/server` (after filling the
`PROXMOX_*` variables in `.env`) to verify credentials, templates and GPU detection.

## LiteLLM gateway

With `LITELLM_BASE_URL` + `LITELLM_API_KEY` set, every coding agent routes through LiteLLM, and the
model is picked from the gateway's `/v1/models` (or set explicitly on the Providers page).

**Context window.** Claude Code assumes a 200k-token window for model names it does not recognise
(every gateway alias), which is wrong for most gateway models: a 57k model would never compact before
hitting API errors, and a 1M model would compact far too early. At agent start Devlet therefore reads
the model's real `max_input_tokens` / `max_output_tokens` from the gateway's
`/model_group/info` and passes them to Claude Code as `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`. The agent log shows the result:
`[devlet] litellm: claude model=decent-code context=57344 max_output=8192`.

- The key needs permission to call the model-info routes. A LiteLLM virtual key restricted to
  `llm_api_routes` (the default for locked-down keys) is denied; allow `info_routes` as well, e.g.
  `allowed_routes: ["llm_api_routes", "info_routes"]`. These routes only return model metadata.
- If the lookup is denied or the model is unknown, Claude Code keeps its 200k default (and shows
  its "isn't described by this version's model catalog" warning). Set `LITELLM_CONTEXT_TOKENS` to
  override the window manually; it takes priority over the discovered value.
