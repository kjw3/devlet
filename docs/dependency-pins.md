# Dependency Pins

This repo pins public container build inputs to explicit upstream releases so
`ghcr.io` images rebuild reproducibly.

Pinned as of 2026-04-12:

| Component | Pinned value | Source |
| --- | --- | --- |
| Node.js 22 LTS image | `node:22.22.2-slim` | Node.js download page / archive |
| pnpm | `10.33.0` | npm registry (`npm view pnpm version`) |
| `@anthropic-ai/claude-code` | `2.1.104` | npm registry |
| `@openai/codex` | `0.120.0` | npm registry |
| `opencode-ai` | `1.4.3` | npm registry |
| `@mariozechner/pi-coding-agent` | `0.66.1` | npm registry |
| `@google/gemini-cli` | `0.37.1` | npm registry |
| `openclaw` npm package | `2026.4.11` | npm registry |
| `ttyd` | `1.7.7` | upstream Git tags |
| `ghcr.io/astral-sh/uv` | `0.9.30` | upstream Git tags |
| `NousResearch/hermes-agent` | `v2026.4.8` | upstream Git tags |
| `qwibitai/nanoclaw` | `v0.9.10` | upstream Git tags |
| `ghcr.io/moltis-org/moltis` | `20260413.01` | Moltis GitHub releases / GHCR tag |
| nginx stable image | `nginx:1.28.3-alpine` | nginx stable release line |

Update process:

1. Re-check upstream versions from the official registry or repo.
2. Update the corresponding `ARG` values in the Dockerfiles.
3. Rebuild and smoke-test the affected images before publishing.
