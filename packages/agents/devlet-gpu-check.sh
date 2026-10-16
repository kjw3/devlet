#!/bin/bash
# devlet/agent-gpu — GPU visibility probe.
# Prints a single "[devlet] gpu:" line for the agent log. Never fails:
# a missing or half-configured GPU must not block agent startup.
set -u

if ! command -v nvidia-smi >/dev/null 2>&1; then
  if ls /dev/nvidia* >/dev/null 2>&1; then
    echo "[devlet] gpu: nvidia devices present but nvidia-smi unavailable (driver userland not injected — check nvidia-container-toolkit)"
  else
    echo "[devlet] gpu: none visible"
  fi
  exit 0
fi

if list=$(nvidia-smi -L 2>&1) && [ -n "$list" ]; then
  count=$(printf '%s\n' "$list" | grep -c '^GPU ' || true)
  echo "[devlet] gpu: ${count} device(s): $(printf '%s\n' "$list" | head -1)"
else
  echo "[devlet] gpu: nvidia-smi present but no usable GPU (${list})"
fi
exit 0
