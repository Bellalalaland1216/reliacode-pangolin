#!/bin/bash
set -Eeuo pipefail
umask 077

APP_DIR=/root/traceability-system
BACKUP_ROOT=/var/backups/reliacode-sqlite
STATE_DIR=/var/lib/reliacode-ops
latest="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
[[ -n "$latest" ]] || { echo 'No backup available' >&2; exit 1; }

work="$(mktemp -d /tmp/reliacode-restore-drill.XXXXXX)"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT HUP INT TERM

(cd "$latest" && sha256sum --check SHA256SUMS)
install -m 0600 "$latest/traceability.db" "$work/traceability.db"
tar -tzf "$latest/public-assets.tar.gz" >/dev/null

result="$(APP_DIR="$APP_DIR" RESTORE_DB="$work/traceability.db" /usr/bin/node <<'NODE'
const path = require('path');
const Database = require(path.join(process.env.APP_DIR, 'node_modules', 'better-sqlite3'));
const db = new Database(process.env.RESTORE_DB, { readonly: true, fileMustExist: true });
const integrity = db.pragma('integrity_check', { simple: true });
if (integrity !== 'ok') throw new Error(`integrity_check=${integrity}`);
const required = ['users', 'brands', 'products', 'boxes', 'items', 'operation_logs'];
const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
for (const table of required) if (!present.has(table)) throw new Error(`missing_table=${table}`);
const counts = Object.fromEntries(required.map(table => [table, db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c]));
db.close();
process.stdout.write(JSON.stringify(counts));
NODE
)"

install -d -m 0700 -o root -g root "$STATE_DIR"
printf 'STATUS=ok\nCHECKED_AT=%q\nBACKUP=%q\nCOUNTS=%q\n' "$(date -Is)" "$latest" "$result" > "$STATE_DIR/restore-drill-last.env"
logger -p daemon.info -t reliacode-restore-drill "Restore drill OK from $latest: $result"
printf 'Restore drill OK from %s: %s\n' "$latest" "$result"
