#!/bin/sh
set -eu

HOME_DIR="${HOME:-/home/agent}"
SYSTEMD_USER_DIR="${HOME_DIR}/.config/systemd/user"
SERVICE_ROOT="${HOME_DIR}/.devlet-services"
ENABLED_DIR="${SERVICE_ROOT}/enabled"
RUN_DIR="${SERVICE_ROOT}/run"

mkdir -p "$SYSTEMD_USER_DIR" "$ENABLED_DIR" "$RUN_DIR"

usage() {
  echo "usage: systemctl [--user] <command> [unit]" >&2
  exit 1
}

unit_path() {
  printf '%s/%s' "$SYSTEMD_USER_DIR" "$1"
}

enabled_marker() {
  printf '%s/%s' "$ENABLED_DIR" "$1"
}

supervisor_pid_file() {
  printf '%s/%s.supervisor.pid' "$RUN_DIR" "$1"
}

child_pid_file() {
  printf '%s/%s.pid' "$RUN_DIR" "$1"
}

is_pid_alive() {
  kill -0 "$1" 2>/dev/null
}

start_unit() {
  unit="$1"
  [ -f "$(unit_path "$unit")" ] || { echo "Unit $unit not found." >&2; exit 1; }

  pid_file="$(supervisor_pid_file "$unit")"
  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$pid" ] && is_pid_alive "$pid"; then
      echo "$unit is already running"
      return 0
    fi
    rm -f "$pid_file"
  fi

  nohup /usr/local/bin/devlet-service-runner run "$unit" >/dev/null 2>&1 &
  sleep 0.2
  echo "Started $unit"
}

stop_unit() {
  unit="$1"
  pid_file="$(supervisor_pid_file "$unit")"
  if [ ! -f "$pid_file" ]; then
    echo "$unit is not running"
    return 0
  fi
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && is_pid_alive "$pid"; then
    kill "$pid" 2>/dev/null || true
  fi
  child_file="$(child_pid_file "$unit")"
  if [ -f "$child_file" ]; then
    child_pid="$(cat "$child_file" 2>/dev/null || true)"
    if [ -n "$child_pid" ] && is_pid_alive "$child_pid"; then
      kill "$child_pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pid_file" "$child_file"
  echo "Stopped $unit"
}

status_unit() {
  unit="$1"
  pid_file="$(supervisor_pid_file "$unit")"
  if [ ! -f "$pid_file" ]; then
    echo "$unit inactive"
    return 3
  fi
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && is_pid_alive "$pid"; then
    echo "$unit active (supervisor pid $pid)"
    return 0
  fi
  echo "$unit failed"
  return 3
}

is_active_unit() {
  unit="$1"
  pid_file="$(supervisor_pid_file "$unit")"
  [ -f "$pid_file" ] || return 3
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [ -n "$pid" ] && is_pid_alive "$pid"
}

enable_unit() {
  unit="$1"
  [ -f "$(unit_path "$unit")" ] || { echo "Unit $unit not found." >&2; exit 1; }
  : > "$(enabled_marker "$unit")"
  echo "Enabled $unit"
}

disable_unit() {
  unit="$1"
  rm -f "$(enabled_marker "$unit")"
  echo "Disabled $unit"
}

args=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --user) shift ;;
    --now) args="--now"; shift ;;
    *) break ;;
  esac
done

[ "$#" -ge 1 ] || usage
command="$1"
unit="${2:-}"

case "$command" in
  daemon-reload)
    exit 0
    ;;
  enable)
    [ -n "$unit" ] || usage
    enable_unit "$unit"
    [ "$args" = "--now" ] && start_unit "$unit"
    ;;
  disable)
    [ -n "$unit" ] || usage
    disable_unit "$unit"
    ;;
  start)
    [ -n "$unit" ] || usage
    start_unit "$unit"
    ;;
  stop)
    [ -n "$unit" ] || usage
    stop_unit "$unit"
    ;;
  restart)
    [ -n "$unit" ] || usage
    stop_unit "$unit"
    start_unit "$unit"
    ;;
  status)
    [ -n "$unit" ] || usage
    status_unit "$unit"
    ;;
  is-active)
    [ -n "$unit" ] || usage
    if is_active_unit "$unit"; then
      echo "active"
      exit 0
    fi
    echo "inactive"
    exit 3
    ;;
  *)
    echo "[devlet] unsupported systemctl command in agent container: $command" >&2
    exit 1
    ;;
esac
