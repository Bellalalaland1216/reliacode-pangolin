#!/bin/bash
set -Eeuo pipefail
umask 077

BACKUP_ROOT=/var/backups/reliacode-sqlite
ENV_FILE=/etc/reliacode/pilot-ops.env
[[ -r "$ENV_FILE" ]] && source "$ENV_FILE"

if [[ -z "${OFFSITE_RCLONE_REMOTE:-}" ]]; then
  echo 'OFFSITE_RCLONE_REMOTE is not configured; refusing to claim an offsite backup.' >&2
  exit 2
fi
command -v rclone >/dev/null || { echo 'rclone is not installed' >&2; exit 2; }

latest="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
[[ -n "$latest" ]] || { echo 'No local backup available' >&2; exit 1; }
rclone copy --immutable --checksum "$latest" "$OFFSITE_RCLONE_REMOTE/$(basename "$latest")"
rclone check --one-way "$latest" "$OFFSITE_RCLONE_REMOTE/$(basename "$latest")"
