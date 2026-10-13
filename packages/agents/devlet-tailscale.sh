#!/bin/bash
# devlet-tailscale — join the tailnet in userspace mode while the agent is running.
# Sourced (. /usr/local/bin/devlet-tailscale) by all devlet agent entrypoints.
# Must not call exec or exit — runs inside the caller's shell.
#
# Userspace networking needs no /dev/net/tun or NET_ADMIN, so it works under every
# Devlet platform. Inbound tailnet traffic only reaches what `tailscale serve` and
# Tailscale SSH explicitly expose — container ports are not otherwise reachable.
#
# Env vars:
#   TS_AUTHKEY      — single-use auth key; when unset Tailscale is skipped entirely
#   TS_HOSTNAME     — tailnet node name (default: devlet-<DEVLET_AGENT_ID or hostname>)
#   TS_TAGS         — advertised tags (default: tag:devlet-agent)
#   TS_SSH          — "false" to disable Tailscale SSH (default: true)
#   DEVLET_TERMINAL_PORT — ttyd port; served on tailnet https :443 when set
# Nodes join as ephemeral, so they leave the tailnet once the container is gone.

_dts_authkey="${TS_AUTHKEY:-}"

if [ -z "$_dts_authkey" ]; then
  echo "[devlet-tailscale] TS_AUTHKEY not set — skipping tailnet"
else
  (
    _dir="${HOME}/.tailscale"
    _sock="${_dir}/tailscaled.sock"
    _host="${TS_HOSTNAME:-devlet-${DEVLET_AGENT_ID:-$(hostname)}}"
    _tags="${TS_TAGS:-tag:devlet-agent}"
    _log="${_dir}/tailscaled.log"
    mkdir -p "$_dir"
    ts() { tailscale --socket="$_sock" "$@"; }

    # ephemeral=true makes the node auto-expire when it goes offline
    case "$_dts_authkey" in *\?*) ;; *) _dts_authkey="${_dts_authkey}?ephemeral=true&preauthorized=true" ;; esac

    tailscaled --tun=userspace-networking --state=mem: --socket="$_sock" >>"$_log" 2>&1 &

    _ssh_flag="--ssh"
    [ "${TS_SSH:-true}" = "false" ] && _ssh_flag="--ssh=false"

    if ! ts up --authkey="$_dts_authkey" --hostname="$_host" --advertise-tags="$_tags" \
         "$_ssh_flag" --accept-dns=false --timeout=60s >>"$_log" 2>&1; then
      echo "[devlet-tailscale] failed to join tailnet — see $_log"
      exit 0
    fi

    # Prefer HTTPS (needs HTTPS certs enabled on the tailnet); fall back to plain HTTP,
    # which is still WireGuard-encrypted.
    _serve() { # <https-port> <http-port> <target-port>
      ts serve --bg --https="$1" "http://127.0.0.1:$3" >>"$_log" 2>&1 \
        || ts serve --bg --http="$2" "http://127.0.0.1:$3" >>"$_log" 2>&1 \
        || echo "[devlet-tailscale] could not serve port $3"
    }
    [ -n "${DEVLET_TERMINAL_PORT:-}" ] && _serve 443 80 "$DEVLET_TERMINAL_PORT"
    case "${DEVLET_AGENT_TYPE:-}" in
      openclaw) _serve 8443 8080 18789 ;;
      moltis)   _serve 8443 8080 13131 ;;
    esac

    echo "[devlet-tailscale] online as ${_host} ($(ts ip -4 2>/dev/null | head -n1))"
  ) &
  echo "[devlet-tailscale] joining tailnet in background"
fi

# Don't leak the auth key to agent processes.
unset TS_AUTHKEY _dts_authkey
