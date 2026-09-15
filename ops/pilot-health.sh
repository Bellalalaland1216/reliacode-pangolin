#!/bin/bash
set -Eeuo pipefail

APP_DIR=/root/traceability-system
BACKUP_ROOT=/var/backups/reliacode-sqlite
STATE_DIR=/var/lib/reliacode-ops
ENV_FILE=/etc/reliacode/pilot-ops.env
MAX_BACKUP_AGE_SECONDS=108000
MAX_DISK_PERCENT=80

[[ -r "$ENV_FILE" ]] && source "$ENV_FILE"
install -d -m 0700 -o root -g root "$STATE_DIR"

errors=()
if ! /usr/bin/curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/login >/dev/null; then
  errors+=("local_http_failed")
fi
if [[ -z "${PUBLIC_BASE_URL:-}" ]]; then
  errors+=("public_base_url_missing")
elif ! /usr/bin/curl --fail --silent --show-error --max-time 15 "${PUBLIC_BASE_URL%/}/login" >/dev/null; then
  errors+=("public_https_failed")
fi

disk_percent="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
if [[ -z "$disk_percent" || "$disk_percent" -ge "$MAX_DISK_PERCENT" ]]; then
  errors+=("disk_usage_${disk_percent:-unknown}_percent")
fi

latest_backup="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 || true)"
if [[ -z "$latest_backup" ]]; then
  errors+=("backup_missing")
else
  backup_epoch="${latest_backup%% *}"
  backup_epoch="${backup_epoch%.*}"
  now_epoch="$(date +%s)"
  backup_age="$((now_epoch - backup_epoch))"
  if [[ "$backup_age" -gt "$MAX_BACKUP_AGE_SECONDS" ]]; then
    errors+=("backup_stale_${backup_age}_seconds")
  fi
fi

if ! APP_DIR="$APP_DIR" /usr/bin/node <<'NODE' >/dev/null
const path = require('path');
const Database = require(path.join(process.env.APP_DIR, 'node_modules', 'better-sqlite3'));
const db = new Database(path.join(process.env.APP_DIR, 'data', 'traceability.db'), { readonly: true, fileMustExist: true });
const result = db.pragma('quick_check', { simple: true });
db.close();
if (result !== 'ok') process.exit(1);
NODE
then
  errors+=("sqlite_quick_check_failed")
fi

checked_at="$(date -Is)"
if (( ${#errors[@]} )); then
  message="ReliaCode pilot health FAILED: ${errors[*]}"
  printf 'STATUS=failed\nCHECKED_AT=%q\nDETAIL=%q\n' "$checked_at" "$message" > "$STATE_DIR/health-last.env"
  logger -p daemon.err -t reliacode-health "$message"
  if [[ -n "${ALERT_WEBHOOK_URL:-}" ]]; then
    payload="$(/usr/bin/node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' "$message")"
    /usr/bin/curl --fail --silent --show-error --max-time 10 -H 'Content-Type: application/json' -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
  exit 1
fi

printf 'STATUS=ok\nCHECKED_AT=%q\nDETAIL=%q\n' "$checked_at" "all_checks_passed" > "$STATE_DIR/health-last.env"
logger -p daemon.info -t reliacode-health "ReliaCode pilot health OK"
