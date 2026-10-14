# Devlet: MVP review and production plan

Scope: take Devlet from "alpha, trusted private network, one operator" to something a team of
mutually trusting-but-accountable engineers can run in production. Out of scope: hostile
multi-tenancy and public SaaS (see "Explicit non-goals").

Reviewed at commit `067dabb` (about 10k lines of TypeScript and shell across `server`, `web`, `cli`,
`shared`, `agents`). The review is from reading the source; the stack was not run.

## 1. State of the MVP

### What works well
- Clear architecture: tRPC server, React UI, CLI, shared zod schemas and per-agent-type images.
- Broad placement: Docker, Portainer and Komodo provision; Proxmox only discovers. GPU-aware scheduler.
- Several access paths to an agent (proxy, direct SSH, tailnet), subdomain-per-agent URLs and
  HMAC-signed proxy tokens.
- Sensible early hygiene: constant-time token compare, secret redaction in API responses,
  loopback-bound agent ports, pinned base images, a documented SSO setup.
- A reconciler loop (`syncAgentStatuses`, 15 s) that restarts persistent agents and flags dead hosts.

### Gaps that block production (ranked)

| # | Area | Finding | Evidence |
|---|------|---------|----------|
| 1 | AuthN/AuthZ | One shared secret. No user identity, owner, roles or sharing. Every user sees, controls and can open a terminal on every agent. | `routers/index.ts:105-129` |
| 2 | Secret blast radius | One `DEVLET_AUTH_TOKEN` is the API credential **and** the HMAC key for all agent-proxy tokens. Leaking it forges access to every agent; rotating it breaks every issued URL. Provider keys (Anthropic, OpenAI, and so on) are forwarded unchanged to every agent container, so any user with a shell can read them. | `agent-access.ts:12-21`, `platforms/env.ts` |
| 3 | Control-plane privilege | The server mounts `/var/run/docker.sock` (root-equivalent on the host). The server image runs as root. | `docker-compose.yml`, `server/Dockerfile` |
| 4 | Agent isolation | Agent containers get CPU and memory limits only: no PID limit, no `no-new-privileges`, no cap drop, no seccomp or read-only rootfs, no network policy. Agents can reach the LAN, the Docker host and other agents. The workspace is not a named volume, so it is lost on removal. | `platforms/docker.ts:270-295` |
| 5 | State and durability | State is YAML files and one JSON file under `~/.devlet`, rewritten without atomic write, locking or versioning. The reconciler and API handlers do read-modify-write on the same files, so lost updates are possible. Agent logs are appended to the state file with no cap. No backup or restore. Secrets (including the full agent env) are stored in plaintext. | `agents/state.ts:211`, `ssh/keyStore.ts` |
| 6 | Reliability | Single process, single replica, no graceful shutdown. The reconciler swallows all errors (`catch {}`) and reprovisions persistent agents on any "not running" signal. Port allocation is check-then-bind (TOCTOU) over fixed ranges. Hire is not idempotent or transactional, so a failure midway can leave an orphan container or Tailscale node. | `index.ts:250-315`, `docker.ts:30-100` |
| 7 | Observability | Fastify logger is off (`Fastify()`): no structured logs, request IDs or metrics. No audit trail of who hired, fired or opened a terminal. `/health` only reports liveness. Only the last 100 container log lines are available. | `index.ts:21`, `docker.ts` |
| 8 | Quality gates | **Zero tests** and no CI for typecheck, lint or tests; CI only publishes images. Images default to `latest`. No dependency or image scanning, no SBOM. Web mocks ship in the source tree. | `.github/workflows`, no `*.test.*` |
| 9 | Web / API hardening | Token stored in `localStorage` (XSS-exposed). No rate limiting or brute-force protection on `/trpc`. The proxy token travels in the URL path (leaks into logs and Referer). No CSP or security headers in `nginx.conf`. `hire` accepts arbitrary per-agent env and a free-form mission. | `App.tsx`, `nginx.conf` |
| 10 | Ops UX | About 60 env vars with no validation at boot. No migrations or versioned state schema. No upgrade path, runbook or sizing guidance. Proxmox provisioning is a stub and `nemoclaw` is a placeholder image. | `docker-compose.yml`, `docs/platforms.md` |
| 11 | Cost control | No quotas, budgets or per-user usage attribution. Hire can request unbounded CPU, memory and GPU. Nothing reaps idle agents (Mission `timeout` and `onComplete` exist but are advisory). | `types/agent.ts` |

## 2. Target definition ("production for a team")

- Authenticated, attributable users. Least privilege by default.
- A compromise of one agent does not expose other agents' data or the platform's long-lived secrets.
- State survives restart, crash and host loss within a stated RPO and RTO.
- Every change is auditable. Operators can see health and cost and get alerted.
- Releases are tested, versioned, reproducible and reversible.
- A new team can install, configure and upgrade it from documentation alone.

## 3. Roadmap

Effort: S is up to 2 days, M is up to 1 week, L is 1 to 3 weeks (one engineer).

### Phase 0: Safety net (about 1 week)
Goal: make later changes safe.
- **CI** on PR: `pnpm typecheck`, build, lint, tests; branch protection on `main`. (S)
- **Test harness**: vitest for `server` and `shared`. Start with the scheduler, env building, state IO,
  token validation and router auth; add an integration test against a mock Docker. (M)
- **Fastify logger** (pino, JSON, request IDs, redacting secrets). (S)
- **Boot-time config validation** (zod over `process.env`), failing fast with readable errors. (S)
- **Versioned releases**: semver tags, stop defaulting to `latest`, pin by digest in compose. (S)
- Dependabot or Renovate, plus `trivy`/`grype` image scanning in CI. (S)

Exit: PRs run green CI with at least 60% coverage on server auth, scheduler and state modules.

### Phase 1: Identity, ownership and roles (about 2 weeks)
The main production blocker.
- `Principal { id, name, email, groups, role }` on the tRPC context. Sources:
  1. trusted proxy headers (authentik, Tailscale), accepted only from configured proxy CIDRs or with a
     proxy-held secret;
  2. per-user API tokens (hashed at rest, scoped, expirable, revocable) for the CLI and automation;
  3. the legacy `DEVLET_AUTH_TOKEN`, demoted to an `admin` break-glass credential. (L)
- Replace the browser `localStorage` token with an HttpOnly, SameSite session cookie when behind SSO. (M)
- `owner` and `sharedWith` on `AgentConfig`, with a migration that assigns existing agents to an admin
  (state schema version 2). Filter `list`, `get` and all mutations. (M)
- Roles: `admin`, `member`, `viewer`. Admins manage platforms, models, providers, SSH keys and users;
  members manage their own and shared agents; viewers are read-only. Map from IdP groups. (M)
- Enforce the same authorisation on every agent-access path (`/agent-access/*`, the subdomain proxy and
  the WebSocket upgrade) by binding proxy tokens to the principal with a short expiry, so a copied URL
  does not grant access. (M)
- Append-only structured audit log: hire, fire, restart, terminal open, SSH key change, role change,
  login. (M)

Exit: a `member` cannot list, view, reach or control another member's agent through the API, UI, CLI or
any proxy path, verified by an automated authorisation matrix test.

### Phase 2: Secrets and isolation (about 2 to 3 weeks)
- Separate `DEVLET_PROXY_SIGNING_KEY` (rotatable, with key IDs) from API credentials. (S)
- Provider keys: stop forwarding platform keys to agents. Prefer **per-agent virtual keys through
  LiteLLM** (integration exists) with budget and expiry per key; this also gives per-user cost
  attribution. For raw provider keys, document the exposure and gate behind an admin setting. (L)
- Encrypt secrets at rest (envelope encryption, key from env or KMS), or at minimum split secrets out of
  the YAML. (M)
- Harden containers: `cap_drop: ALL` with a minimal allow list, `no-new-privileges`, default seccomp,
  `pids_limit`, ulimits, read-only rootfs where the agent allows it, and a named volume for
  `/workspace`. (M)
- Network policy: per-agent Docker network by default, egress allow-list (LLM gateway, package
  registries, tailnet), block host, metadata and LAN ranges. (L)
- Remove the raw Docker socket from the main server: a socket proxy exposing only the needed verbs, or a
  separate small runner service. Run the server as non-root. (M)
- Deliver the Tailscale auth key via file or secret instead of env, so it is not in `docker inspect`. (S)

Exit: a written threat model (section 5), with each listed attack mitigated or explicitly accepted.

### Phase 3: Durable state and reliability (about 2 to 3 weeks)
- Move state from YAML/JSON to **SQLite (WAL) or Postgres** behind a repository interface, with
  migrations. SQLite suffices for one replica; Postgres is the HA path. (L)
- Transactional hire and fire as a persisted state machine
  (`pending → provisioning → running → …`) with compensation for orphan cleanup, driven by an idempotent
  reconciler that uses leases. (L)
- Reconciler that records errors, backs off, caps restart loops (CrashLoop status) and emits events. (M)
- Port allocation: let Docker assign ephemeral host ports and read them back, or allocate under a lock
  with retry on bind failure. (S)
- Logs: stream to disk or DB with rotation instead of appending to state; show retention in the UI;
  optional shipping to Loki or syslog. (M)
- Backups: scripted snapshot and restore of the state store, with the restore tested in CI. (M)
- Graceful shutdown and a readiness probe that checks the state store and the Docker socket. (S)

Exit: `kill -9` of the server or a reboot during a hire leaves no orphans and a consistent state; a
documented restore works end to end.

### Phase 4: Observability and operations (about 1 to 2 weeks)
- Prometheus `/metrics` (agents by status, hire latency, reconciler errors, platform health, proxy
  sessions) and a ready-made Grafana dashboard. (M)
- OpenTelemetry traces across hire/provision and the platform adapters. (M)
- Alerts and runbooks: platform unreachable, reconciler stuck, restart loops, disk and quota. (S)
- Webhook or Slack notifications for agent completion, failure and quota breaches. (M)
- Admin "doctor" command and UI page validating config, platform credentials, Tailscale ACLs and image
  pulls. (M)

### Phase 5: Team features (about 2 to 3 weeks)
- **Quotas and budgets**: per-user and per-group caps on concurrent agents, CPU, memory, GPU and
  LiteLLM spend, enforced in `hire`, with admin overrides and clear errors. (L)
- **Lifecycle policy**: default TTL and idle timeout enforced by the server (using `Mission.timeout` and
  `onComplete`), auto-reap, and a "keep alive" extension. (M)
- **Templates and policy**: admin-curated agent templates (image, resources, network profile, allowed
  providers); restrict free-form env and image overrides to admins. (M)
- **Per-user credentials**: users supply their own Git and provider credentials, stored encrypted and
  injected only into their agents. (M)
- Finish or remove unfinished surface: Proxmox provisioning (L), the `nemoclaw` placeholder and the web
  mock data in `packages/web/src/mocks` (S).

### Phase 6: Hardening, release and documentation (about 1 to 2 weeks)
- Security review and external pen test of the control plane and proxy; fix findings. (M)
- Rate limiting and lockout on the API, CSP and security headers in nginx, and the proxy token moved out
  of URL paths where feasible (cookie-bound session on the agent subdomain). (M)
- Load and soak tests: N concurrent hires, 50+ long-lived agents, WebSocket terminal soak. (M)
- Production docs: reference architecture (reverse proxy, SSO, firewall), sizing, upgrade and rollback,
  backup and restore, incident runbooks, threat model and `SECURITY.md`. Drop the README alpha banner
  only when the exit criteria are met. (M)
- API and state-schema versioning policy with upgrade tests from the previous release. (S)

## 4. Sequencing and milestones

| Milestone | Phases | Calendar (1 engineer) | Meaning |
|-----------|--------|-----------------------|---------|
| M1 "Team beta" | 0 + 1 | about 3 weeks | Safe for a trusted team on a private network, with per-user access and an audit trail. |
| M2 "Hardened" | 2 + 3 | about 5 to 6 more weeks | Isolation, durable state and safe recovery. Can hold real project credentials. |
| M3 "Production 1.0" | 4 + 5 + 6 | about 5 to 7 more weeks | Observable, governed, documented and security-reviewed. |

Total is roughly 13 to 16 engineer-weeks. Two engineers can overlap Phase 1 with Phase 3 once Phase 0
is done, provided the state schema is settled first.

Critical path: Phase 0 (tests), then the Phase 1 state-schema change, then Phase 3 (database). If the
database move is going to happen anyway, do the SQLite migration at the start of Phase 1 so the
owner and principal fields are not migrated twice.

## 5. Threat model to write down (Phase 2 input)

1. A team member reaches another member's agent or reads their workspace. (Phase 1)
2. A malicious or prompt-injected agent reads platform secrets from its environment. (Phase 2)
3. An agent pivots to the Docker host or socket, the LAN or other agents. (Phase 2)
4. A leaked `DEVLET_AUTH_TOKEN` or proxy URL grants lasting access. (Phases 1 and 2)
5. A stolen browser token (XSS or a shared machine). (Phases 1 and 6)
6. State corruption or loss from a concurrent write or a crash. (Phase 3)
7. A supply-chain attack through `latest` images or unpinned dependencies. (Phase 0)
8. Cost abuse: runaway agents or unbounded LLM spend. (Phase 5)

## 6. Explicit non-goals (for 1.0)

- Hostile multi-tenancy or internet-facing SaaS. Containers share a kernel; stronger isolation
  (gVisor, Kata or Firecracker VMs) is a separate track.
- Horizontal HA of the control plane (the Postgres path keeps the door open).
- Replacing the platform adapters with Kubernetes.

## 7. Key decisions needed

1. Identity source for v1: proxy headers (authentik/Tailscale) only, or also built-in local users?
2. State store: SQLite (simpler, single replica) or Postgres (HA path)?
3. Provider-key strategy: require LiteLLM virtual keys, or allow raw provider keys with documented risk?
4. Isolation bar for 1.0: hardened containers plus network policy, or sandboxed runtimes (gVisor/Kata)?
5. Which platforms are in the 1.0 support matrix? (Proxmox provisioning is the largest unfinished item.)
