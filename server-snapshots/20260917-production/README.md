# ReliaCode legacy production application snapshot

This directory is the rebuildable source snapshot for the SQLite/Express
application deployed at `8.140.52.117` on 2026-09-17. It is kept separately
from `apps/scan-api` and `apps/scan-web`, which are the next-generation SaaS
implementation.

The snapshot intentionally excludes databases, sessions, generated QR files,
uploads, backups, credentials, certificates and environment files.

## Rebuild

Requirements: Node.js 22 or 24, a compiler toolchain supported by
`better-sqlite3`, and a writable private data directory.

```bash
npm ci --omit=dev
NODE_ENV=production \
RELIACODE_DATA_DIR=/srv/reliacode-data \
INITIAL_ADMIN_PASSWORD='set-at-deploy-time' \
ALLOWED_HOSTS='trace.example.com,127.0.0.1,localhost' \
node server.js
```

`INITIAL_ADMIN_PASSWORD` is used only when an empty production database has no
administrator. Never commit it. Reverse proxy traffic to `127.0.0.1:3000` and
terminate HTTPS at the proxy.

Optional controls:

- `IMAGE_ARCHIVE_MAX_CODES` defaults to 500 and is capped at 2,000.
- `IMAGE_ARCHIVE_MAX_CONCURRENT` defaults to 1 and is capped at 2.

Large production packages must use the streaming link-TXT or pure-code-TXT
downloads. Image archives are intentionally bounded because the legacy ZIP
builder is in-memory.

## Acceptance

```bash
node --check server.js
npm test
```

Before deployment, compare the manifest, back up every replaced live file,
run the tests against a fresh temporary database, and perform authenticated
route checks. Production deployment must never copy a database or `.env` from
this repository.

