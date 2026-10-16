# Devlet

![Alpha](https://img.shields.io/badge/status-alpha-orange)
![Private Network Only](https://img.shields.io/badge/deployment-private%20network%20only-red)

Devlet is an AI agent orchestration platform for running and supervising agent containers from a local control plane.

## Alpha Status

This project is **alpha software**.

It is currently intended for:

- home lab use
- private network experimentation
- local development
- small-scale operator testing by technically capable users

It is **not** intended for:

- open internet exposure
- multi-tenant environments
- production workloads
- sensitive or regulated environments

The codebase is still evolving, the security model is still maturing, and breaking changes should be expected.

## Safety Boundary

Treat Devlet as a privileged control plane.

- The server manages agent containers and, if you opt in with `docker-compose.local-docker.yml`, has access to the host Docker socket.
- A compromised Devlet server can become a host compromise path.
- Run it only on machines and networks you control.
- Put it behind strong authentication and TLS if you expose it beyond localhost (for SSO, see [docs/authentik-caddy.md](docs/authentik-caddy.md)).

If you are evaluating this project, assume the safe deployment target is a **trusted private network**, not a public SaaS-style environment.

## What It Does

Devlet provides:

- a web UI and CLI for hiring, supervising and firing agents
- a server control plane that schedules agents onto your infrastructure and tracks them
- agent images for coding agents (Claude Code, Codex, OpenCode, Pi, Gemini) and gateway agents
  (OpenClaw, Hermes, Moltis), each with a web terminal and optional SSH
- placement across **local Docker, Portainer, Komodo and Proxmox**, with GPU-aware scheduling
- several ways to reach a running agent: the Devlet proxy, direct host/port SSH, and your
  **Tailscale tailnet** (see below)
- Docker-based deployment and image publishing support

### Platforms

| Platform | Notes |
| --- | --- |
| Docker | Local Docker socket (opt-in via `docker-compose.local-docker.yml`). |
| Portainer | Endpoints discovered from the Portainer API; GPU info comes from endpoint snapshots. |
| Komodo | Servers discovered from Komodo. Devlet detects each server's LAN address and NVIDIA GPUs by itself, even when Komodo's agent runs in a container (see [Komodo notes](docs/platforms.md#komodo)). |
| Proxmox | Full deployment platform: one LXC or QEMU guest per agent (see [Proxmox notes](docs/platforms.md#proxmox)); GPU-required hires get PCI passthrough ([docs/gpu-agents.md](docs/gpu-agents.md)). |

### Reaching an agent

Each agent's detail page lists every way in. Use whichever fits where you are:

- **Devlet proxy** — a token-protected link served by the Devlet server (web terminal, OpenClaw/Moltis UI).
- **Direct host/port** — `ssh agent@<host> -p <port>` on the platform host's LAN address.
- **Tailnet** — `ssh agent@devlet-<id>` and an HTTPS terminal URL from any device on your tailnet,
  while the agent is running. The Devlet server can also route its proxy over the tailnet when an
  agent's host address is unreachable. See [docs/tailscale.md](docs/tailscale.md).

## Quick Start

### 1. Create your config

```bash
cp .env.example .env
```

Set at minimum:

- `DEVLET_AUTH_TOKEN`
- any provider API keys you want forwarded to agents

Generate an auth token with:

```bash
openssl rand -hex 32
```

### 2. Start the stack

```bash
docker compose up --build
```

The server does not get the host Docker socket by default, so the local **Docker** platform is
off (and hidden in the UI). To place agents on the Docker daemon of the machine Devlet runs on,
add the opt-in override: `docker compose -f docker-compose.yml -f docker-compose.local-docker.yml up -d`.
Platforms without credentials (Portainer, Komodo, Proxmox) are hidden the same way.

By default the services bind to loopback only:

- web UI: `http://127.0.0.1:3000`
- server API: `http://127.0.0.1:3001`

### 3. Sign in

Open the web UI and enter the `DEVLET_AUTH_TOKEN` value from your `.env`.

### 4. (Optional) Connect platforms and Tailscale

Configure the platforms you use (`PORTAINER_*`, `KOMODO_*`, `PROXMOX_*` in `.env.example`) and, to
put agents on your tailnet, follow [docs/tailscale.md](docs/tailscale.md). Platform and Tailscale
connection status is shown in the UI (sidebar and **Settings**).

## Container Images

This repo includes Dockerfiles and GitHub Actions for publishing images to `ghcr.io`.

Published images are intended to support reproducible private deployments, not to imply that the software is production-hardened.

## Security Notes

- Do not deploy this on a public IP without an additional security review.
- Do not treat the current authentication layer as sufficient for hostile-network exposure.
- Do not store real production secrets in ad hoc agent configuration unless you understand the trust model.
- Agent web terminals have no password of their own — they rely on the Devlet proxy token, loopback
  binding, and (on the tailnet) your Tailscale ACLs. Keep `tag:devlet-agent` locked down; do not let
  agents reach `tag:devlet-server`.
- The Tailscale auth key handed to an agent is single-use and short-lived but visible in
  `docker inspect` until it expires.
- The Devlet server and Komodo/Portainer integrations run helper containers on your hosts
  (`busybox:1.37` to read a host's LAN address, `debian:12-slim` to query NVIDIA GPUs); both are pulled
  once per host that needs them.
- Review image pins in [docs/dependency-pins.md](docs/dependency-pins.md) before publishing your own builds.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
```

To run the stack from local source instead of the published `ghcr.io` images:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d
```

Agent images are only rebuilt by CI (`.github/workflows/publish-ghcr.yml`); to test agent-image
changes locally, build `packages/agents/Dockerfile.base` and point `AGENT_IMAGE_CLAUDE_CODE` (etc.)
at your local tag.

## License

Apache License 2.0. See [LICENSE](LICENSE).
