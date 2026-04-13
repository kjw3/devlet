#!/bin/bash
# devlet-ssh — start an agent-local sshd in the background when SSH access is enabled.
# Sourced (. /usr/local/bin/devlet-ssh) by agent entrypoints.
# Must not call exec or exit — runs inside the caller's shell.

_ds_port="${DEVLET_SSH_PORT:-}"
_ds_authorized_keys_b64="${DEVLET_SSH_AUTHORIZED_KEYS_B64:-}"
_ds_host_key_private_b64="${DEVLET_SSH_HOST_KEY_PRIVATE_B64:-}"
_ds_host_key_public_b64="${DEVLET_SSH_HOST_KEY_PUBLIC_B64:-}"
_ds_username="${DEVLET_SSH_USERNAME:-$(id -un)}"

if [ -z "$_ds_port" ] || [ -z "$_ds_authorized_keys_b64" ] || [ -z "$_ds_host_key_private_b64" ] || [ -z "$_ds_host_key_public_b64" ]; then
  echo "[devlet-ssh] SSH disabled — missing port or key material"
else
  _ds_home="${HOME:-/home/${_ds_username}}"
  _ds_ssh_dir="${_ds_home}/.ssh"
  _ds_runtime_dir="${_ds_home}/.devlet-ssh"
  _ds_host_key="${_ds_runtime_dir}/ssh_host_ed25519_key"
  _ds_config="${_ds_runtime_dir}/sshd_config"
  _ds_auth_keys="${_ds_ssh_dir}/authorized_keys"
  _ds_log="${_ds_runtime_dir}/sshd.log"

  mkdir -p "$_ds_ssh_dir" "$_ds_runtime_dir"
  chmod 700 "$_ds_ssh_dir" "$_ds_runtime_dir"

  # Wire up the profile hook so SSH login shells source ~/.devlet-env.
  # The env file itself is written (and refreshed after tool init) by the
  # entrypoint; this just ensures the sourcing line is present.
  if ! grep -qF '.devlet-env' "${_ds_home}/.profile" 2>/dev/null; then
    printf '\n[ -f ~/.devlet-env ] && . ~/.devlet-env\n' >> "${_ds_home}/.profile"
  fi

  printf '%s' "$_ds_authorized_keys_b64" | base64 -d > "$_ds_auth_keys"
  printf '%s' "$_ds_host_key_private_b64" | base64 -d > "$_ds_host_key"
  printf '%s' "$_ds_host_key_public_b64" | base64 -d > "${_ds_host_key}.pub"
  chmod 600 "$_ds_auth_keys" "$_ds_host_key"
  chmod 644 "${_ds_host_key}.pub"

  cat > "$_ds_config" <<EOF
Port ${_ds_port}
ListenAddress 0.0.0.0
HostKey ${_ds_host_key}
PidFile ${_ds_runtime_dir}/sshd.pid
AuthorizedKeysFile ${_ds_auth_keys}
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin no
UsePAM no
PrintMotd no
StrictModes no
Subsystem sftp internal-sftp
EOF

  if /usr/sbin/sshd -D -e -f "$_ds_config" >>"$_ds_log" 2>&1 & then
    echo "[devlet-ssh] started on port $_ds_port for user $_ds_username"
  else
    echo "[devlet-ssh] failed to start"
  fi
fi

unset _ds_port _ds_authorized_keys_b64 _ds_host_key_private_b64 _ds_host_key_public_b64
unset _ds_username _ds_home _ds_ssh_dir _ds_runtime_dir _ds_host_key _ds_config _ds_auth_keys _ds_log
