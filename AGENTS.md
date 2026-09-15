# ReliaCode development and deployment agreement

These rules apply to all work in this repository.

## Remotes and environments

- `upstream` is `https://github.com/NSIETeam/ReliaCode` and is the official source repository.
- `origin` is `git@github.com:Bellalalaland1216/reliacode-pangolin.git`, the personal development repository.
- Production is `/root/traceability-system` on the project server. It currently has no Git metadata and must not be treated as a `git pull` deployment.
- Until the production implementation is reconciled with this repository, the current production files are the source of truth for the live UI. Never replace them with an older local or upstream tree.

## Required Git checkpoint for each stage

After each independently reviewable and reversible stage of work:

1. Confirm the current branch, remotes, and working-tree state before editing.
2. Work on a dedicated feature branch. Do not develop or push directly on `main` unless the user explicitly requests it.
3. Review `git diff` and the staged file list for unrelated changes or sensitive material.
4. Run checks or tests appropriate to the change.
5. Create a descriptive Git commit and push the verified stage to `origin`.
6. Record the commit SHA, checks run, and deployment status. A stage is not complete until its commit has been pushed.

A stage normally means one page, component, user flow, bug fix, or tightly related visual adjustment. A commit is not required for every file save.

## Never commit

- `.env`, production configuration, tokens, passwords, private keys, certificates, or SSH files. `.env.example` may contain invalid examples only.
- Authenticated `.npmrc` content.
- `data/`, `backups/`, `node_modules/`, databases, WAL/SHM files, logs, temporary files, generated QR codes, or production uploads.

Stop before pushing if a credential or production record may be present. Remove it from the full Git history before continuing.

## Production deployment

1. Re-read `/root/traceability-system/AGENTS.md` and confirm that no one else is changing the same files.
2. Compare SHA-256 hashes immediately before deployment and make the smallest patch against the current live files.
3. Back up every replaced file under `backups/<timestamp>/`.
4. Run relevant tests, `node --check server.js` when server code is involved, and `nginx -t`.
5. Restart through PM2, run `pm2 save`, and verify `127.0.0.1:3000` plus public HTTPS.
6. Record the deployed Git commit SHA so the release can be identified and rolled back.

Git synchronizes source history. Production databases and runtime data stay outside Git and follow the server backup procedure.
