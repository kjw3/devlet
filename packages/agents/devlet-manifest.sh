#!/bin/sh
# devlet-manifest — record and re-apply system/npm/pip package installs so an
# agent's toolset survives stop/start AND full reprovision (rebuild).
#
# The manifest lives at ~/.devlet/manifest.tsv on the persistent home volume,
# one entry per line:  <kind>\t<name>\t<version>
#   kind:    apt | npm | pip
#   name:    package name (npm/pip may be "pkg@version")
#   version: pinned version or "-" for latest
#
# Commands:
#   devlet-manifest apply            apply the manifest (run by the entrypoint, as root)
#   devlet-manifest add <kind> <pkg> [version]   record a package (and install it now)
#   devlet-manifest remove <kind> <pkg>          remove a recorded package
#   devlet-manifest list             print the manifest
#
# `apply` is idempotent and best-effort: it never fails the boot.

set -u

MANIFEST_DIR="${HOME:-/home/agent}/.devlet"
MANIFEST="${MANIFEST_DIR}/manifest.tsv"

mkdir -p "$MANIFEST_DIR"
[ -f "$MANIFEST" ] || : > "$MANIFEST"

# sudo is available for the agent user (see /etc/sudoers.d/devlet in the image).
SUDO="sudo -n"

# ── add / remove: edit the manifest (deduped by kind+name) ───────────────────
manifest_upsert() {  # $1 kind  $2 name  $3 version
  kind="$1"; name="$2"; version="${3:--}"
  tmp="${MANIFEST}.tmp.$$"
  awk -F'\t' -v k="$kind" -v n="$name" -v v="$version" '
    ($1==k && $2==n) { next }            # drop any existing entry for this pkg
    { print }
  ' "$MANIFEST" > "$tmp"
  printf '%s\t%s\t%s\n' "$kind" "$name" "$version" >> "$tmp"
  mv "$tmp" "$MANIFEST"
}

manifest_remove() {  # $1 kind  $2 name
  kind="$1"; name="$2"
  tmp="${MANIFEST}.tmp.$$"
  awk -F'\t' -v k="$kind" -v n="$name" '($1==k && $2==n) { next } { print }' "$MANIFEST" > "$tmp"
  mv "$tmp" "$MANIFEST"
}

install_now() {  # $1 kind  $2 name  $3 version
  kind="$1"; name="$2"; version="${3:--}"
  case "$kind" in
    apt)
      [ "$version" = "-" ] || name="${name}=${version}"
      $SUDO apt-get update -qq >/dev/null 2>&1 || true
      $SUDO apt-get install -y -qq --no-install-recommends "$name" >/dev/null 2>&1 \
        && echo "[devlet-manifest] installed apt:$name" || echo "[devlet-manifest] FAILED apt:$name"
      ;;
    npm)
      [ "$version" = "-" ] || name="${name}@${version}"
      $SUDO npm install -g --no-fund --no-audit "$name" >/dev/null 2>&1 \
        && echo "[devlet-manifest] installed npm:$name" || echo "[devlet-manifest] FAILED npm:$name"
      ;;
    pip)
      [ "$version" = "-" ] || name="${name}==${version}"
      $SUDO python3 -m pip install --quiet --no-input "$name" >/dev/null 2>&1 \
        && echo "[devlet-manifest] installed pip:$name" || echo "[devlet-manifest] FAILED pip:$name"
      ;;
    *)
      echo "[devlet-manifest] unknown kind: $kind (use apt|npm|pip)" >&2
      return 1
      ;;
  esac
}

cmd="${1:-list}"
case "$cmd" in
  apply)
    # Apply every recorded package. The entrypoint runs as the `agent` user, so
    # installs go through sudo (configured in /etc/sudoers.d/devlet). If invoked
    # directly as root (e.g. by a host helper), sudo is skipped.
    if [ "$(id -u)" = "0" ]; then SUDO=""; else SUDO="sudo -n"; fi
    # Refresh apt package lists once (best-effort) so installs don't fail
    # against a stale base-image cache after a reprovision.
    $SUDO apt-get update -qq >/dev/null 2>&1 || true
    count=0
    while IFS="$(printf '\t')" read -r kind name version; do
      [ -n "$kind" ] || continue
      count=$((count + 1))
      case "$kind" in
        apt)
          [ "${version:--}" = "-" ] || name="${name}=${version}"
          $SUDO apt-get install -y -qq --no-install-recommends "$name" >/dev/null 2>&1 \
            || echo "[devlet-manifest] apply: apt:$name not installed"
          ;;
        npm)
          [ "${version:--}" = "-" ] || name="${name}@${version}"
          $SUDO npm install -g --no-fund --no-audit "$name" >/dev/null 2>&1 \
            || echo "[devlet-manifest] apply: npm:$name not installed"
          ;;
        pip)
          [ "${version:--}" = "-" ] || name="${name}==${version}"
          $SUDO python3 -m pip install --quiet --no-input "$name" >/dev/null 2>&1 \
            || echo "[devlet-manifest] apply: pip:$name not installed"
          ;;
      esac
    done < "$MANIFEST"
    echo "[devlet-manifest] applied $count package(s)"
    ;;

  add)
    kind="${2:-}"; name="${3:-}"; version="${4:--}"
    [ -n "$kind" ] && [ -n "$name" ] || { echo "usage: devlet-manifest add <apt|npm|pip> <package> [version]" >&2; exit 1; }
    manifest_upsert "$kind" "$name" "$version"
    install_now "$kind" "$name" "$version"
    ;;

  remove)
    kind="${2:-}"; name="${3:-}"
    [ -n "$kind" ] && [ -n "$name" ] || { echo "usage: devlet-manifest remove <apt|npm|pip> <package>" >&2; exit 1; }
    manifest_remove "$kind" "$name"
    echo "[devlet-manifest] removed $kind:$name from manifest"
    ;;

  list)
    if [ -s "$MANIFEST" ]; then
      printf '%-6s %-40s %s\n' "KIND" "PACKAGE" "VERSION"
      cat "$MANIFEST"
    else
      echo "(no packages recorded)"
    fi
    ;;

  *)
    echo "usage: devlet-manifest <apply|add|remove|list> ..." >&2
    exit 1
    ;;
esac
