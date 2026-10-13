# Dependency Pins

This repo pins public container build inputs to explicit upstream releases so
`ghcr.io` images rebuild reproducibly.

Pinned as of 2026-10-13:

| Component | Pinned value | Source |
| --- | --- | --- |
| Node.js 22 LTS image (server/web builds) | `node:22.23.3-slim` | Node.js download page / archive |
| Node.js 24 LTS image (agent base; OpenClaw requires >=24.16) | `node:24.21.0-slim` | Node.js download page / archive |
| pnpm | `10.33.0` | npm registry (`npm view pnpm version`) |
| `@anthropic-ai/claude-code` | `2.1.296` | npm registry |
| `@openai/codex` | `0.162.1` | npm registry |
| `opencode-ai` | `1.19.0` | npm registry |
| `@mariozechner/pi-coding-agent` | `0.73.1` | npm registry |
| `@google/gemini-cli` | `0.63.0` | npm registry |
| `openclaw` npm package | `2026.4.11` | npm registry |
| `ttyd` | `1.7.7` | upstream Git tags |
| `herdr` (`herdrdev/herdr`) | `v0.9.3` (sha256-verified in `Dockerfile.base`) | GitHub releases; pick a release at least two weeks old |
| `tmux` | Debian package | apt |
| `ghcr.io/astral-sh/uv` | `0.13.0` | upstream Git tags |
| `NousResearch/hermes-agent` | `v2026.9.24` | upstream Git tags |
| `qwibitai/nanoclaw` | `v0.9.10` | upstream Git tags |
| `ghcr.io/moltis-org/moltis` | `20260413.01` | Moltis GitHub releases / GHCR tag |
| nginx stable image | `nginx:1.30.5-alpine` | nginx stable release line |

Update process:

1. Re-check upstream versions from the official registry or repo.
2. Update the corresponding `ARG` values in the Dockerfiles.
3. Rebuild and smoke-test the affected images before publishing.

Held back (newer upstream releases need migration work, not just a pin bump):

- `openclaw` 2026.10.x requires Node >=24 and a new config schema (`ui.assistant` retired,
  `agents.list` -> `agents.entries`); the `openclaw.json` writer in `entrypoint.openclaw.sh`
  must be updated first.
- `moltis` 20260913.x needs `libzvec_c_api.so` at runtime, which the current image does not ship.
- `qwibitai/nanoclaw` v2026.10.x enforces a sanctioned install path ("upgrade tripwire"); the
  git-clone install in `Dockerfile.nanoclaw` no longer works.

Always start each gateway agent (not just `--version`) before publishing a bump.
