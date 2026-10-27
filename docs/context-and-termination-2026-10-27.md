# Context defaults and retained termination diagnostics

Implemented October 27, 2026. Production rollout is recorded below; existing agent containers were not restarted.

## Why

`agent-10n9` failed provisioning and retained only `[object Object]`. Start then silently did nothing for its `pending` runtime reference while marking it running. `agent-uhyv` started Pi successfully, but the only assistant response exhausted 8,192 output tokens with thinking content and no answer or tool call. Its container was subsequently destroyed by normal nonpersistent-agent cleanup. Pi's surviving home-volume session made that diagnosis possible; normal runtime exit details were lost.

These agents used Komodo on sbx1. The first agent's saved offline message alone does not prove that host was down. The original provisioning cause and the second container's OS exit code could not be recovered.

## Retained evidence

The reconciler captures stdout/stderr and allowlisted Docker runtime fields before destroying a nonpersistent runtime: status, exit code, OOMKilled, start/finish timestamps, and runtime error. Docker, Portainer and Komodo support inspection; Proxmox retains guest output and the existing guest disk, with an explicit note that this path does not supply a container exit code.

Evidence appears in the agent's existing Logs view and YAML state. New runtime output is bounded to the last 500 returned lines and 64 KiB, plus a small runtime-state record. Known secret/internal environment values, bearer tokens and common credential assignments are redacted. This is best-effort redaction, not a guarantee that arbitrary task output contains no secrets. Agent output can contain mission content and remains accessible under the existing authenticated logs access controls.

The state write must succeed before cleanup. Capture has a 10-second deadline. If capture fails/times out, Devlet records that evidence is unavailable and leaves the runtime for inspection; explicit delete/fire still performs teardown. Cleanup failures are recorded. Existing terminated state files remain compatible. These changes cannot recreate logs already deleted.

Start now throws for `pending`, causing the existing router fallback to provision the agent. Structured provisioning exceptions are serialized, bounded and redacted rather than converted to `[object Object]`.

## Local Pi audit

Read `~/.pi/agent/settings.json`, selected nonsecret model metadata from `models.json`, and installed Pi source. No credentials, MCP account configuration, session contents or personal prompts were copied. Local Pi is 1.4.0; the base image was pinned to 1.3.0 and is now pinned to 1.4.0.

| Decent tier | Context | Output cap | Compaction reserve | Recent history |
| --- | ---: | ---: | ---: | ---: |
| fast, chat/code | 32,768 | 4,096 | 16,384 | 4,096 |
| standard, chat/code | 65,536 | 8,192 | 16,384 | 8,192 |
| large, chat/code | 262,144 | 8,192 | 32,768 | 16,384 |

Local settings enable compaction and default thinking to off. Model metadata explicitly supports reasoning effort and maps off to `none`; unsupported levels are null. This distinction matters: context compaction cannot fix a first response that consumes its entire output budget on thinking.

## Translation into the base image

`devlet-context-config.py` runs during coding-tool initialization for tools configured to use LiteLLM. Gateway model-group limits are preferred, with `LITELLM_CONTEXT_TOKENS` taking precedence for context. The six audited Decent aliases provide a fallback when metadata is inaccessible. Other aliases need reported limits; unknown Pi aliases still receive a basic provider entry without guessed token sizes. Reserve sizes are bounded for small windows and increased when needed for a larger reported output cap. Explicit existing context-helper settings are preserved; bootstrap's preexisting provider/login configuration behavior is otherwise unchanged.

- **Pi:** explicit context/output metadata; model-specific compaction reserve/recent settings; compaction enabled; thinking off with the audited Decent effort mapping. Existing models/settings are merged rather than replacing the Pi catalog.
- **Codex:** `model_context_window` and `model_auto_compact_token_limit = context - reserve`. Existing Responses provider and authentication behavior continues.
- **OpenCode:** provider model context/output limits; automatic compaction, old-tool-output pruning and a reserved token buffer. Applies only when the selected model matches the intended LiteLLM model.
- **Gemini CLI 0.64.0:** unknown aliases internally use a 1,048,576-token window. The compression fraction is scaled against that internal denominator so compression starts at the intended real-window threshold; output is capped through a matching model override. The default compression alias is pointed at the selected gateway model. This is a version-specific workaround, not a change to Gemini's context display or internal model registry; recheck it when updating Gemini.
- **Claude Code:** wrapper-scoped real context/output limits and an earlier compaction percentage, preserving explicit environment overrides. No unsupported recent-history token setting is invented.

Pi's exact recent-history retention control has no identical portable setting across the other harnesses. Their native compactors retain and summarize history differently. This change does not claim equivalent summarization quality or change LiteLLM admission/reasoning policy.

## Validation and reproducibility

Run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 packages/agents/context-config.test.py
bash -n packages/agents/devlet-coding-init.sh
cd packages/server
../../node_modules/.bin/tsc --noEmit --tsBuildInfoFile /tmp/devlet-server-check.tsbuildinfo
node --import tsx --test src/agents/*.test.ts src/platforms/*.test.ts
```

Build and smoke-test without production credentials:

```sh
docker build -f packages/agents/Dockerfile.base -t devlet/agent-base:context-diagnostics .
docker run --rm --network none --entrypoint bash \
  -v "$PWD/packages/agents/context-base-smoke.sh:/tmp/context-smoke.sh:ro" \
  devlet/agent-base:context-diagnostics /tmp/context-smoke.sh
```

The smoke test generates all five configurations and runs the installed harness version commands. An actual Pi headless turn talks only to a loopback mock gateway and asserts `reasoning_effort=none`, output cap 8,192, and an answer. It does not benchmark inference, exercise production gateways, or establish long-running compaction quality. The local image build is ARM64; production AMD64 image validation and rollout remain separate steps.

## Upstream references

- [Codex configuration reference](https://developers.openai.com/codex/config-reference/)
- [OpenCode compaction configuration](https://opencode.ai/docs/config/#compaction)
- [Gemini CLI configuration](https://geminicli.com/docs/reference/configuration/)
- [Gemini 0.64.0 token limits](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/core/tokenLimits.ts)
- [Gemini 0.64.0 model configuration](https://github.com/google-gemini/gemini-cli/blob/v0.64.0/packages/core/src/services/modelConfigService.ts)
- [Claude Code context and compaction](https://code.claude.com/docs/en/model-config#context-window-and-auto-compaction)

## Production rollout

Implementation commit: `f61a5296a86fc8710c71155ef74b0e9464c7f14f`, pushed to main. Validation passed: 90 server tests, 5 context tests, TypeScript checking, shell syntax and whitespace checks, plus the isolated local-image smoke test.

The server image published for both AMD64 and ARM64. Before deployment, the SHA-tagged AMD64 server image was pulled on sbx4 and checked against latest; its OCI revision matched the implementation commit. The managed compose SHA-256 matched the repository (`cfa31fc099846c5c5d709902f110f6b1f6760296bf135d0e591203bb2ee6bcc2`), auto-pull was enabled, no image overrides were present, and no agents were provisioning.

Komodo DeployStack operation `6ae0b889dff6d841833081d7` completed successfully October 27 at approximately 10:43 a.m. EDT. The server runs revision `f61a5296a86fc8710c71155ef74b0e9464c7f14f`; the unchanged web image was retained. Server health and the web root returned HTTP 200. All five saved agent statuses matched the pre-deployment snapshot, including the three running persistent agents. Authenticated saved-log queries for both originally investigated terminated agents succeeded. No historical output already deleted was reconstructed.

Rollback material on sbx4: `/var/backups/devlet/pre-f61a529-20261027.tgz`, `/var/backups/devlet/pre-f61a529-images.txt`, and the local Docker tag `devlet-server:rollback-f61a529`. A protected stack-configuration and agent-status snapshot is also stored under the Devlet state volume's `backups/pre-f61a529-20261027/` directory. Backups contain private configuration and must stay protected.

The base agent image published successfully for AMD64 and ARM64 in [publication run 40523248709](https://github.com/kjw3/devlet/actions/runs/40523248709). Its SHA-tagged AMD64 image was pulled and smoke-tested on sbx4 with external networking disabled and dummy credentials only. The OCI revision matched the implementation commit. All five harness launchers reported the pinned versions; all five context configurations were generated; an actual Pi request to the loopback mock sent `reasoning_effort=none` with an 8,192-token cap and received an answer. Existing agents were not restarted. Derived GPU/Hermes/Moltis/OpenClaw image jobs were still running when the application/base-image rollout verification finished; those jobs do not require another app-stack deployment.
