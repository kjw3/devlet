#!/bin/sh
# Start any user services previously enabled through the systemctl shim.
# Sourced by agent entrypoints before launching the primary process.

_dsv_home="${HOME:-/home/agent}"
_dsv_enabled="${_dsv_home}/.devlet-services/enabled"

mkdir -p "$_dsv_enabled"

for _dsv_marker in "$_dsv_enabled"/*; do
  [ -f "$_dsv_marker" ] || continue
  _dsv_unit="$(basename "$_dsv_marker")"
  systemctl --user start "$_dsv_unit" >/dev/null 2>&1 || true
done

unset _dsv_home _dsv_enabled _dsv_marker _dsv_unit
