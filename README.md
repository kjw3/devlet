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

- The server manages agent containers and may have access to the host Docker socket.
- A compromised Devlet server can become a host compromise path.
- Run it only on machines and networks you control.
- Put it behind strong authentication and TLS if you expose it beyond localhost.

If you are evaluating this project, assume the safe deployment target is a **trusted private network**, not a public SaaS-style environment.

## What It Does

Devlet provides:

- a web UI for managing agents
- a server control plane for launching and tracking agent runtimes
- multiple agent images for different tools and workflows
- Docker-based deployment and image publishing support

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

By default the services bind to loopback only:

- web UI: `http://127.0.0.1:3000`
- server API: `http://127.0.0.1:3001`

### 3. Sign in

Open the web UI and enter the `DEVLET_AUTH_TOKEN` value from your `.env`.

## Container Images

This repo includes Dockerfiles and GitHub Actions for publishing images to `ghcr.io`.

Published images are intended to support reproducible private deployments, not to imply that the software is production-hardened.

## Security Notes

- Do not deploy this on a public IP without an additional security review.
- Do not treat the current authentication layer as sufficient for hostile-network exposure.
- Do not store real production secrets in ad hoc agent configuration unless you understand the trust model.
- Review image pins in [docs/dependency-pins.md](docs/dependency-pins.md) before publishing your own builds.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
```

## License

Apache License 2.0. See [LICENSE](LICENSE).
