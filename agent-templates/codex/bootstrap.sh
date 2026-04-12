#!/bin/bash
# Codex agent bootstrap
set -euo pipefail

echo "[devlet] Agent ${DEVLET_AGENT_ID} starting"
echo "[devlet] Mission: ${DEVLET_MISSION:-<none>}"

# TODO (Codex): parse DEVLET_MISSION and execute steps
exec tail -f /dev/null
