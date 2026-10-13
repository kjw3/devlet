# Platform notes

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

## Portainer

Endpoints are discovered from the Portainer API. Agent ports are published on `0.0.0.0` of the
endpoint's Docker host and reached through the endpoint's address.

## Docker (local)

Agents run on the Docker socket mounted into the Devlet server. Published ports bind to loopback on
the Docker host and the server proxies to them via `DEVLET_DOCKER_PROXY_HOST`
(default `host.docker.internal`).

## Proxmox

Discovery and placement only; provisioning agents on Proxmox is not implemented yet.

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
