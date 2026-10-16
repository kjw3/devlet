# Proxmox provisioning — implementation plan

Status: in progress. This is the working plan for taking Proxmox from discovery +
placement (current) to a full deployment platform: provision, lifecycle, access, status,
logs, GPU.

Design decisions are marked **D1–D8**; requirements **R1–R8**; work is phased **P0–P7**
with verification per phase. Update the checkboxes as phases land.

## Goal

`devlet hire` on a Proxmox-placed agent produces a running, reachable agent — terminal,
SSH, logs, persistent restart — with the same UX as the Docker/Portainer/Komodo platforms.

## Design decisions

**D1 — Agent runtime inside the guest is Docker running the existing agent images.**
Every agent behaviour (ttyd terminal, sshd, tailscale, mission loop) ships in the
`AGENT_IMAGE` container images. We run the same image unchanged inside the guest:

```
docker run -d --name devlet-agent --restart unless-stopped \
  --env-file /etc/devlet-agent.env \
  -p 7681:7681 -p 2222:2222 [...type-specific ports] \
  ghcr.io/kjw3/devlet-agent-base:<tag>
```

- Reuses `buildContainerEnv` verbatim (Komodo already proves this path works over a
  newline-escaped env file).
- nanoclaw's hard requirement ("spawns its own containers — must not run inside a
  Devlet-managed Docker container") is satisfied structurally: the guest has its own
  Docker daemon.
- LXC guests need `unprivileged=1`, `features: nesting=1,keyctl=1`.
- A guest without Docker is bootstrapped over SSH (P2); the recommended setup is a
  pre-baked template with Docker preinstalled so bootstrap is a single `docker run`.

**D2 — Guest bootstrap over SSH.** The PVE API has no exec endpoint. Devlet generates a
dedicated provisioning keypair once (stored in `~/.devlet/proxmox-provision-key`, like
`ssh/keyStore.ts`), injects the public key at LXC create (`ssh-public-keys` param) and
expects it in the QEMU template. All guest commands (install docker, write env file,
start container, fetch logs) run over SSH as root using that key. The server image
already ships `openssh-client`.

**D3 — VMIDs are derived deterministically from the agent id** (range 4100–4999, clear of
typical user VMs): `vmid = 4100 + (hash(agentId) % 900)`, probing upward past guests that
exist but are not named `devlet-{agentId}`. Reprovisioning (reconciler restarts) re-derives
the same VMID, finds the existing guest by name and starts it instead of recreating. The
platformRef `proxmox:{node}:{vmType}:{vmId}` remains the source of truth once provisioned.

**D4 — One guest per agent → fixed ports.** Unlike Komodo/Portainer (many containers per
shared host, hence port-range allocation), each Proxmox agent gets a dedicated guest, so
there are no cross-agent port collisions. Proxmox agents use fixed ports set explicitly
into agent env: `DEVLET_TERMINAL_PORT=7681`, `DEVLET_SSH_PORT=2222`, plus type-specific
(`OPENCLAW_HOST_PORT=18789`, `MOLTIS_HOST_PORT=13131`). No allocation logic needed.

**D5 — Guest IP resolution order for the access proxy:**
1. LXC: `GET /nodes/{node}/lxc/{vmid}/interfaces` → first global IPv4 (not `lo`).
2. QEMU: `GET /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces` (requires
   `qemu-guest-agent` in the template and `agent: 1` in VM config — documented template
   requirement).
3. Tailnet fallback: the agent container joins the tailnet itself (`withTailscaleEnv` is
   platform-agnostic), so `findAgentDevice(agentId)` resolves exactly as it does for
   Komodo agents.
4. No reachable address → access surfaces render as unavailable (no fake localhost).

**D6 — GPU support is template-first.** The QEMU template owns machine type (q35), BIOS
(OVMF) and GPU passthrough (`hostpci0`); cloning inherits it. Optional
`PROXMOX_GPU_PCI_ID` overrides/sets `hostpci0` at clone time for templates without it.
`gpuCount` detection reads `/nodes/{node}/hardware/pci` and counts VGA/3D-class devices,
feeding the existing scheduler logic unchanged.

**D7 — Auth minimal privileges.** Dedicated PVE user `devlet@pam` with an API token
("privilege separation" on) holding, scoped to the target pool/storage: `PVEVMAdmin`,
`PVEDatastoreUser` (+ `Datastore.AllocateTemplate` for template reads, `VM.Clone`,
`VM.Allocate` for creation). TLS: `PROXMOX_INSECURE=true` for self-signed certs (already
supported).

**D8 — Preconditions are enforced before hire is accepted, not at provision time.** The
scheduler may pick Proxmox (or the user may override placement to it); the hire mutation
validates the chosen node has a usable template (LXC template path resolves in storage
content; QEMU template ID exists and is a template) and returns a clear 412-style error
otherwise. nanoclaw is never offered when no QEMU/LXC template is configured.

## Requirements

- **R1 (API client).** A `proxmox-client.ts` providing token-authed GET/POST/PUT/DELETE,
  UPID task polling with timeout and error extraction, `cluster/nextid`, storage-content
  and guest-listing reads, guest IP resolution (D5), and PCI device listing (D6).
- **R2 (config).** Server parses `PROXMOX_NODE`, `PROXMOX_STORAGE` (default `local-lvm`),
  `PROXMOX_LXC_TEMPLATE`, `PROXMOX_QEMU_TEMPLATE_ID`; `.env.example`/compose already
  carry them. Boot probes log which Proxmox features are unusable and why.
- **R3 (provision).** LXC create + QEMU full-clone paths, resource mapping
  (`resources.cpus` → cores, `resources.memoryMb` → memory MiB, `storageMb` → rootfs
  size), deterministic VMID (D3), env file + `docker run` bootstrap (D1), returns
  `proxmox:{node}:{vmType}:{vmId}`. Idempotent: re-provision reuses/starts the existing
  guest; failed creations clean up.
- **R4 (lifecycle).** `stopAgent` = guest shutdown (API, force-stop after grace);
  `removeAgent` = destroy + purge; `getAgentRunning` checks guest power **and the
  inner Docker container**. Probe failures return unknown, not exited. The reconciler
  restarts persistent containers without replacing their workspace; finished
  non-persistent tasks have logs saved, guests powered down, and state marked terminated.
  Guest disks remain until explicit fire/delete.
- **R5 (logs).** `docker logs --tail N devlet-agent` over SSH, falling back to stored
  state logs when the guest is unreachable; provisioning task output (UPID log) surfaced
  on failure.
- **R6 (access).** `ensureAgentAccessPorts` Proxmox branch (D4 fixed ports);
  `resolveAgentAccessHost` / `resolveAgentProxyTargetHost` return guest IP with tailnet
  fallback (D5) so terminal proxy, subdomain URLs, SSH command and OpenClaw/Moltis
  origins all work.
- **R7 (GPU).** `probeProxmox` reports `gpuCount`; QEMU clone sets/keeps `hostpci0`
  (D6); a GPU-required hire lands on a QEMU guest with the GPU passed through.
- **R8 (docs/UX).** `docs/platforms.md` Proxmox section rewritten (template preparation
  guide, permissions, port model); hire UI single-task Proxmox exclusion removed
  (`HireAgent.tsx`); nemoclaw stays gated until its image exists.

## Phases

### P0 — Plan + scaffolding (no credentials needed) ✅ this document
- [x] Write plan; confirm decisions D1–D8 against codebase.

### P1 — API client foundation (`packages/server/src/platforms/proxmox-client.ts`) ✅
- [x] Token auth (reuses header logic from `proxmox.ts`), GET/POST/PUT/DELETE, JSON
      envelope handling, `PROXMOX_INSECURE` handling.
- [x] `waitForTask(upid, {timeoutMs})` polling `/nodes/{node}/tasks/{upid}/status`
      (exit status + task-log tail on failure via `ProxmoxTaskError`).
- [x] `deriveVmidBase(agentId)` + `allocateVmid()` conflict probe (D3),
      `devletGuestName()`, `getNextVmid()`.
- [x] `listClusterGuests`, `getLxcGuestIp`, `getQemuGuestIp` (D5),
      `listPciDevices`/`countGpuDevices`/`firstGpuPciId` (D6), storage-content reads.
- [x] Unit tests with a stubbed transport (`proxmox-client.test.ts`, `node --test`),
      workspace typecheck green.

### P2 — Config, probe enrichment, preconditions ✅
- [x] Parse `PROXMOX_NODE`, `PROXMOX_STORAGE`, `PROXMOX_LXC_TEMPLATE`,
      `PROXMOX_QEMU_TEMPLATE_ID`, `PROXMOX_GPU_PCI_ID`, `PROXMOX_BRIDGE` in `config.ts`.
- [x] `probeProxmox` reports per-node `gpuCount` and readiness fields
      (`lxcTemplateReady`, `qemuTemplateReady`, `provisioningBlocker`).
- [x] Hire-time precondition check (D8): `validateProxmoxPlacement()` wired into the
      hire mutation — offline/unknown node, missing LXC or QEMU template fail
      synchronously with a clear message (60 s result cache).

### P3 — Provisioning (code complete; live verification pending credentials)
- [x] Provisioning keypair generation + storage (`proxmox-ssh.ts`, D2) and the
      guest-script runner (base64-in-argv, BatchMode, timeouts).
- [x] `createProxmoxGuest`: LXC path (create → start → wait IP → SSH bootstrap →
      `docker run`) and QEMU path (clone → config/cores/memory (+ hostpci0, + cloud-init
      sshkeys when the template uses it) → start → guest-agent IP → SSH bootstrap).
- [x] Env injection via single-quoted `docker run -e` args (reuses `buildContainerEnv`),
      fixed ports (D4), `--restart unless-stopped` for persistent agents.
- [x] `provisionAgent` case `proxmox` wired; failures destroy partially created guests;
      reuse path starts an existing `devlet-{agentId}` guest instead of recreating (D3).
- [x] Live probe script: `packages/server/scripts/proxmox-probe.ts`.
- [x] Live verification against the operator's Proxmox: claude-code agents hired on
      LXC (vmid 4857) and QEMU (full-clone vmid 4845; linked-clone vmid 4964 after the
      template moved to ceph-vms); Docker auto-installed in guests, agent container up.

### P4 — Access paths (code complete; live-verified)
- [x] `ensureAgentAccessPorts` proxmox branch — fixed ports 7681/2222 (+18789/13131).
- [x] Guest-IP host resolution (`resolveProxmoxAgentHost`, 30 s cache) in
      `agent-access.ts`; SSH display + OpenClaw origins use it; tailnet fallback comes
      free via the platform-agnostic `selectUpstream`.
- [x] Verify: terminal proxy returns HTTP 200 on LXC and QEMU agents (tokenized
      `/agent-access/{id}/terminal/{token}/` route); guest SSH (provisioning key) works;
      tailnet fallback untested in-app (tailscale unavailable on the dev host).

### P5 — Lifecycle, status, logs (code complete; live-verified)
- [x] `stopAgent` (graceful shutdown, force-stop fallback), `removeAgent` (destroy +
      purge), `getAgentRunning` (guest power + inner Docker runtime) wired into `dispatch.ts` (R4).
- [x] Reconciler: `running === false` restarts persistent guests (reuse path starts the
      existing guest/container); unreachable API marks the agent error instead of skipping (R4).
- Single-task hires (`mission.onComplete=terminate`) use LXC only, enforced at hire
  validation. Long-running hires default to LXC, with a QEMU dropdown override;
  GPU passthrough requires QEMU. Excluded targets are hidden from the dropdowns.
- Finished tasks no longer advertise SSH/terminal links; saved proxy URLs return
  HTTP 410 once termination has been reconciled (15-second polling interval).
- [x] `getAgentLogs` via SSH `docker logs`, falling back to stored state logs (R5);
      provisioning failures surface the PVE task log tail in the agent's error.
- [x] Verify: fire removes the guest in PVE (✓ verified live; no orphans left, failed
      hires cleaned up via the created-callback + `removeOrphanedProvision`); logs work
      over guest SSH. Persistent-agent out-of-band-stop restart untested live.

### P6 — GPU end-to-end (needs a GPU node)
- [x] `gpuCount` in probe; scheduler path already consumes it (R7).
- [x] `hostpci0` handling on clone (D6): PVE restricts `hostpci*` to root@pam — even a
      fully-privileged token gets "only root can set 'hostpci0' config". GPU hires put
      the config update through an optional root token
      (`PROXMOX_ROOT_USER`/`PROXMOX_ROOT_TOKEN_ID`/`PROXMOX_ROOT_TOKEN_SECRET`, created
      via `pveum user token add root@pam <id> --privsep 0`); per-node GPU auto-detection
      picks the PCI id (`pcie=1` for q35). GPUs already passed through to other VMs
      (gpu1/gpu2 on this cluster) are detected via their hostpci configs and rejected at
      hire time — live `nvidia-smi` verification deferred until a GPU is free (also
      requires IOMMU enabled on the GPU nodes).

### P7 — Docs and cleanup (mostly done)
- [x] `docs/platforms.md`: Proxmox section rewritten (guest model, requirements, fixed
      ports, access, lifecycle, probe command).
- [x] `.env.example` + `docker-compose.yml`: `PROXMOX_GPU_PCI_ID`, `PROXMOX_BRIDGE`;
      stale `tasks/codex/004-proxmox-deploy.md` reference removed from `dispatch.ts`.
- [x] Single-task Proxmox exclusion removed from `HireAgent.tsx` (single-task nanoclaw
      is now schedulable).
- [x] Final pass after live verification: nemoclaw stays gated until a real image
      exists; production-plan.md gap #10 note relaxed (Proxmox provisioning no longer
      listed as a stub).

## Verification summary (exit criteria)

1. `pnpm typecheck` green across the workspace; P1 client unit tests pass.
2. A claude-code agent hired onto LXC and onto QEMU reaches `running`, opens a working
   terminal in the UI, and completes a mission.
3. Firing the agent removes the guest from Proxmox; state clean.
4. A persistent agent shut down out-of-band is restarted by the reconciler.
5. GPU-required hire lands on a QEMU guest with `nvidia-smi` visible (P6).
6. Docs updated; no remaining "not implemented" Proxmox paths in `dispatch.ts`.
