#!/bin/bash
# Claude Code agent bootstrap
# Environment variables injected by devlet:
#   DEVLET_AGENT_ID     — agent ID
#   DEVLET_MISSION      — JSON-encoded mission object
#   DEVLET_SERVER       — devlet server URL for callbacks
#   ANTHROPIC_API_KEY   — API key (passed from config.env)

set -euo pipefail

echo "[devlet] Agent ${DEVLET_AGENT_ID} starting"
echo "[devlet] Mission: ${DEVLET_MISSION:-<none>}"

# TODO (Codex): parse DEVLET_MISSION and execute steps
# For now, just keep the container alive
exec tail -f /dev/null
