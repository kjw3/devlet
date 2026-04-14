#!/bin/bash
# devlet/agent-moltis entrypoint
# Configures Moltis from env vars and starts the gateway service.
set -e

. /usr/local/bin/devlet-terminal
. /usr/local/bin/devlet-ssh
. /usr/local/bin/devlet-coding-init

MISSION="${DEVLET_AGENT_MISSION:-}"
AGENT_NAME="${DEVLET_AGENT_NAME:-Moltis}"
PORT="${MOLTIS_PORT:-13131}"
PROVIDER="${MOLTIS_PROVIDER:-anthropic}"
API_KEY="${MOLTIS_API_KEY:-${ANTHROPIC_API_KEY:-}}"

# MOLTIS_PASSWORD is required by the unattended-setup bypass: when all three of
# MOLTIS_PASSWORD, MOLTIS_PROVIDER, MOLTIS_API_KEY are set before first launch,
# Moltis skips the browser configuration wizard entirely.
# We use a stable value derived from the agent name; [auth] disabled = true in
# the toml means this password is never actually enforced for access.
MOLTIS_PASSWORD="${MOLTIS_PASSWORD:-devlet-${AGENT_NAME}}"

export MOLTIS_PASSWORD MOLTIS_PROVIDER="${PROVIDER}" MOLTIS_API_KEY="${API_KEY}"

echo "[devlet] moltis starting (port=$PORT provider=$PROVIDER)..."

# Write Moltis config from env vars. Must be written before moltis starts so
# it doesn't generate its own default and ignore our port/provider settings.
# Config structure per https://docs.moltis.org/configuration:
#   port is under [server], provider keys under [providers.<name>].
mkdir -p ~/.config/moltis
cat > ~/.config/moltis/moltis.toml <<EOF
[identity]
name = "${AGENT_NAME}"

[server]
port = ${PORT}

[tls]
# Disable TLS so the browser can connect without cert warnings.
# The gateway is local-only (host port binding); plain HTTP is fine.
enabled = false

[auth]
# Disable auth — Docker bridge IP is not localhost from Moltis's perspective
# so remote-auth would trigger the setup wizard. Local port binding protects it.
disabled = true

[providers]
offered = ["${PROVIDER}"]

[providers.${PROVIDER}]
api_key = "${API_KEY}"
EOF

# If a mission is provided, write it to HEARTBEAT.md in the moltis data dir.
# Moltis reads this file on startup and runs it as the initial prompt
# (startup log: "heartbeat skipped: no prompt in config and HEARTBEAT.md is empty").
mkdir -p ~/.moltis
if [ -n "$MISSION" ]; then
  echo "[devlet] mission queued via HEARTBEAT.md"
  printf '%s' "$MISSION" > ~/.moltis/HEARTBEAT.md
else
  # Ensure HEARTBEAT.md is empty so a stale mission from a previous run isn't re-executed.
  : > ~/.moltis/HEARTBEAT.md
fi

# --bind forces the port even though moltis rewrites its config template on every
# fresh-container start (overwriting any pre-written moltis.toml).
# 0.0.0.0 makes the gateway reachable from outside the container.
exec moltis --bind "0.0.0.0"
