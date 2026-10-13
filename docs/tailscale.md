# Tailscale integration

Devlet can put running agents on your [Tailscale](https://tailscale.com) tailnet. Each agent
joins as its own node (`devlet-<agent-id>`) while it is running and leaves when it stops, so you
can reach it from any device on the tailnet without port mapping or host-address configuration.

What an agent exposes on the tailnet:

| Surface | How to reach it |
| --- | --- |
| SSH | `ssh agent@devlet-<agent-id>` (Tailscale SSH — no keys to distribute) |
| Web terminal | `https://devlet-<agent-id>.<tailnet>.ts.net/` |
| OpenClaw / Moltis UI | `https://devlet-<agent-id>.<tailnet>.ts.net:8443/` |

The agent detail page shows these under **connections → tailnet**, next to the existing
local-proxy link and direct host/port SSH. Use whichever suits where you are: the tailnet from
anywhere, the proxy link through the Devlet UI, or direct host/port on the LAN.

The Devlet server can also join the tailnet. When it does, the agent-access proxy falls back to an
agent's tailnet address if the platform host's address is unreachable from the server (NAT, an
unmapped host, …). Direct host addresses are still preferred when they work.

## How it works

- **Userspace networking.** Agents run `tailscaled` with `--tun=userspace-networking`, so no
  `/dev/net/tun`, `NET_ADMIN` or privileged mode is needed. It behaves the same on Docker,
  Portainer and Komodo. Inbound tailnet traffic only reaches what `tailscale serve` and Tailscale
  SSH explicitly publish.
- **Ephemeral nodes.** Nodes join with an ephemeral key, so they disappear from the tailnet when
  the container is gone. Devlet also deletes the node immediately when you fire or delete an agent,
  and clears any stale node before a restart so the name is reused (no `-1` suffix).
- **Per-launch keys.** The server holds an OAuth client and mints a **single-use, pre-authorized,
  ephemeral, tagged** auth key for every launch (hire, restart, recover). The key is not saved in
  agent state. It is passed to the container as `TS_AUTHKEY`, expires after an hour, and is
  removed from the agent's shell environment after use. Note it remains visible in
  `docker inspect` until it expires; because it is single-use it is worthless after the agent joins.
- **Best effort.** If Tailscale is misconfigured or the API is down, agents still launch — just
  without tailnet access (a warning is logged by the server).

## Setup

### 1. Tailnet settings

In the [admin console](https://login.tailscale.com/admin) enable **MagicDNS** and **HTTPS
Certificates** (DNS page). Without HTTPS certificates agents fall back to plain HTTP and the
generated https links will not work.

### 2. Policy file

Under **Access controls**, define the tags, let yourself reach the agents, let the server reach the
agents, and allow Tailscale SSH as the `agent` user. Replace the email with your own login:

```json
{
  "tagOwners": {
    "tag:devlet-agent":  ["you@example.com"],
    "tag:devlet-server": ["you@example.com"]
  },
  "grants": [
    { "src": ["you@example.com"],     "dst": ["tag:devlet-agent"], "ip": ["*"] },
    { "src": ["tag:devlet-server"],   "dst": ["tag:devlet-agent"], "ip": ["*"] }
  ],
  "ssh": [
    {
      "action": "accept",
      "src": ["you@example.com"],
      "dst": ["tag:devlet-agent"],
      "users": ["agent"]
    }
  ]
}
```

Use `"action": "check"` in the SSH rule to require a recent re-authentication. **Do not** grant
`tag:devlet-agent` access to `tag:devlet-server` or to other agents — agents run model-driven code
and should not be able to reach the control plane. The ACL on `tag:devlet-agent` is the access
control for the agent terminals, which have no password of their own.

### 3. Two OAuth clients

Go to **Settings → Trust credentials → Credential → OAuth**.

> Tailscale only mints a key when the request names **all** of an OAuth client's tags. Agents and
> the server therefore need **separate** clients, each limited to one tag. A client holding both
> tags makes every single-tag request fail with `requested tags … are invalid or not permitted`.

| Client | Scopes | Tag |
| --- | --- | --- |
| Agents | Auth Keys: **Write**, Devices (Core): **Write** | `tag:devlet-agent` only |
| Server (optional) | Auth Keys: **Write** | `tag:devlet-server` only |

Devices write is what lets Devlet delete a node when you fire an agent; with read-only access
deletion fails with a 403 and nodes linger until they expire.

### 4. Environment

```bash
# Agents (required to enable the integration)
TAILSCALE_OAUTH_CLIENT_ID=...
TAILSCALE_OAUTH_CLIENT_SECRET=...

# Server node (optional — enables the tailnet proxy fallback)
TAILSCALE_SERVER_OAUTH_CLIENT_ID=...
TAILSCALE_SERVER_OAUTH_CLIENT_SECRET=...
```

Restart the server after changing these (or after changing an OAuth client's scopes — the server
caches its OAuth token for up to an hour).

| Variable | Default | Purpose |
| --- | --- | --- |
| `TAILSCALE_OAUTH_CLIENT_ID` / `_SECRET` | — | Agent OAuth client. Unset disables the whole integration. |
| `TAILSCALE_SERVER_OAUTH_CLIENT_ID` / `_SECRET` | — | Server OAuth client. Unset keeps the server off the tailnet. |
| `TAILSCALE_TAILNET` | `-` | Tailnet name; `-` is the OAuth client's own tailnet. |
| `TAILSCALE_AGENT_TAG` | `tag:devlet-agent` | Tag applied to agent nodes. |
| `TAILSCALE_SERVER_TAG` | `tag:devlet-server` | Tag applied to the server node. |
| `TAILSCALE_SERVER_ENABLED` | `true` | Set `false` to keep the server off the tailnet even with credentials. |
| `TAILSCALE_DEFAULT_ENABLED` | `true` | Set `false` to make tailnet exposure opt-in per agent. |

Check **Settings → Tailscale** in the UI: it shows whether the API is reachable, how many agent
nodes are online, and whether the server itself is on the tailnet.

## Using it

- **Per agent:** the hire form has an **Expose on tailnet** checkbox (on by default when the
  integration is configured). Unchecking it hires the agent with `DEVLET_TAILSCALE=false`.
- **CLI:** `devlet ssh <agent-id>` prints the tailnet SSH command when the agent is on the tailnet
  and falls back to the host/port form otherwise.
- Tailscale SSH runs as the non-root `agent` user, so log in as `agent@…`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Agent log: `failed to join tailnet: invalid key` | Key rejected — check the OAuth client scopes/tags and that the tag is in `tagOwners`. |
| `requested tags [...] are invalid or not permitted` | The tag is not in `tagOwners`, is not on the OAuth client, or the client holds more than one tag (see above). |
| Fired agents leave nodes behind / restarts get a `-1` name | OAuth client lacks Devices (Core) write, or the server holds a token from before you added it — restart the server. |
| Terminal link does not load | HTTPS certificates are not enabled on the tailnet, or your ACL does not grant you access to `tag:devlet-agent`. |
| `ssh agent@…` is refused | The policy `ssh` rule is missing, or you are logging in as a user other than `agent`. |
| Settings says the server is not on the tailnet | Server OAuth client unset, or `tag:devlet-server` is missing from `tagOwners`; see the server log line `[tailscale] server could not join the tailnet`. |

The agent-side logic lives in `packages/agents/devlet-tailscale.sh`; the server side is in
`packages/server/src/tailscale/`.
