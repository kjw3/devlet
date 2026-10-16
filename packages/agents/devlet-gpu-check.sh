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
  # Data-plane check — nvidia-smi working only proves the management plane;
  # enumeration can be fine while every compute op fails. Runs the raw-driver
  # probe (context, alloc, copy, JIT kernel) and reports one line on success,
  # full stage output on failure. Never fails startup.
  if command -v python3 >/dev/null 2>&1 && [ -x /usr/local/bin/devlet-cuda-probe ]; then
    if out=$(python3 /usr/local/bin/devlet-cuda-probe 2>&1); then
      echo "[devlet] gpu: compute OK (context, alloc, copy, JIT kernel)"
    else
      echo "[devlet] gpu: WARNING compute probe FAILED — agent will run but GPU compute is broken:"
      printf '%s\n' "$out" | sed 's/^/[devlet] gpu:   /'
    fi
  fi
else
  echo "[devlet] gpu: nvidia-smi present but no usable GPU (${list})"
fi
exit 0
