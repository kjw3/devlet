#!/bin/bash
# devlet-terminal — start ttyd web terminal in the background
# Sourced (. /usr/local/bin/devlet-terminal) by all devlet agent entrypoints.
# Must not call exec or exit — runs inside the caller's shell.
#
# Env vars:
#   DEVLET_TERMINAL_PORT   — port ttyd listens on (required; allocated at hire time)
#   DEVLET_TERMINAL_TOKEN  — basic-auth password; username is always "devlet"

_dt_port="${DEVLET_TERMINAL_PORT:-}"
_dt_token="${DEVLET_TERMINAL_TOKEN:-}"

if [ -z "$_dt_port" ]; then
  echo "[devlet-terminal] DEVLET_TERMINAL_PORT not set — skipping terminal"
else
  # No --credential: the devlet HMAC proxy token already authenticates the
  # connection. Browser JS cannot set Authorization headers on WebSocket
  # upgrades (browser security restriction), so Basic Auth through a proxy
  # silently breaks the terminal connection.
  ttyd \
    --port "$_dt_port" \
    --writable \
    bash </dev/null >/dev/null 2>&1 &
  echo "[devlet-terminal] started on port $_dt_port"
fi

unset _dt_port _dt_token
