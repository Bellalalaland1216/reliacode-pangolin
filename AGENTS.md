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

## 单屏页面 UI 规范（2026-09-17）

- 登录、注册等单屏页面必须按可用视口宽度和高度共同适配，一屏内完整显示，不出现页面级横向或纵向滚动。
- 优先使用克制的卡片宽度、字号、控件高度和留白；矮窗口可采用紧凑或多列排版，不能只按宽度放大整张设计图。
- 禁止仅隐藏 overflow 来掩盖内容溢出；输入框、错误反馈、主要操作及返回入口均须可见、可点击，保留键盘操作和可读性。
- 验收覆盖桌面、笔记本、系统缩放对应的小视口、手机竖屏及横屏，并检查默认、报错和条件展开状态。
- UI 调整保留既有业务逻辑及已确认的视觉素材；注册界面当前先本地验收，部署按用户后续指示执行。
