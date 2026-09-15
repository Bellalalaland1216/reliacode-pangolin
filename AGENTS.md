# ReliaCode server coordination note

This directory is a live production-pilot deployment. Do not replace `server.js`,
`database.js`, or files under `views/` with an older local copy.

Before making changes:

1. Read this file and inspect the current live files first.
2. Compare SHA-256 hashes immediately before deployment.
3. Back up every file that will be replaced under `backups/<timestamp>/`.
4. Apply a minimal patch to the current live version; do not upload a whole stale tree.
5. Run `node --check server.js`, authenticated smoke tests, and `nginx -t`.
6. Restart with PM2, run `pm2 save`, and confirm ports and public HTTPS health.

Required fixes that must not be reverted:

- Node listens on `127.0.0.1:3000`; only Nginx exposes the application.
- Public QR URLs follow the trusted proxy protocol and therefore use HTTPS in production.
- Generated box/item results include their database `id` so the generation page can
  download exactly the codes from the current operation.
- `/print` permits both platform administrators and brand administrators.
- Code-package QR/SVG generation receives a request-local base URL; never restore a
  process-global request host cache.
- Session cookies use `httpOnly`, `sameSite=lax`, and `secure=auto` behind Nginx.
- PM2 runs with `NODE_ENV=production`; do not revert it to an unset environment.
- Password creation and reset paths enforce the 12-character mixed-class pilot policy.
- `reliacode-health.timer`, `reliacode-backup.timer`, and
  `reliacode-restore-drill.timer` are production-pilot gates. Keep their latest
  successful state visible under `/var/lib/reliacode-ops`.
- Do not claim offsite backup unless `ops/offsite-sync.sh` has completed against
  a real remote destination and its checksum verification passed.

The preferred long-term deployment source is a reviewed Git commit and GitHub Actions,
not direct ad-hoc root uploads. If another agent is actively changing this deployment,
coordinate with the user before overwriting its work.

## Git checkpoints

- The personal repository is `git@github.com:Bellalalaland1216/reliacode-pangolin.git`
  and uses the remote name `origin`.
- Use a dedicated feature branch. Do not develop or push directly on `main` unless the
  user explicitly requests it.
- After each independently reviewable stage, inspect the diff, run relevant checks,
  create a descriptive commit, and push it to the `Bellalalaland1216` personal remote.
- Record the commit SHA, checks, and deployment status. A stage is not complete until
  its commit has been pushed.
- Never commit production data, uploads, logs, backups, environment files, credentials,
  private keys, certificates, authenticated `.npmrc` content, or generated QR codes.
- Git synchronizes source history only. Production data follows the server backup plan.
