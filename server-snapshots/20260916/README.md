# 线上穿山甲生产码包：一键生成、下载及超时重试防重复

此目录保存 2026-09-16 已部署到 `8.140.52.117` 的 `traceability-system` 的 [后端最小补丁](traceability-system/server.idempotency.patch) 和 [`views/downloads.ejs`](traceability-system/views/downloads.ejs)。生产试点是 Express/EJS 实现，和仓库主线 `apps/scan-api`、`apps/scan-web` 不同；这里没有完整生产服务源码、数据库、环境变量、依赖或部署配置，**不能单独用于重新部署完整服务**，也不能直接覆盖主线应用。

本次部署前后 SHA-256：

| 文件 | 部署前 | 本快照/线上当前 |
| --- | --- | --- |
| `server.js` | `57825f623c25bbadee8c0e08fabea23078c848024000fbc6e6ea26a6dc94888c` | `c793379623ef075e1ac035e7884b5da6d5bb23ce7e5536e5ccede357503911c7` |
| `views/downloads.ejs` | `056f8fde8ca8a3be6c546a16cd4e83875554d7a0539e937c44310a5a13c0a7e6` | `a63120cf98cd2826a57c2c3e0955f2ff4951edfb5c55ed745af877ca6fc5dbd8` |
| `database.js` | `48520dcef8e94351e29ce66f299c6976f2f1bd80d41c3b2d7e221bc8b7689691` | 未修改，不在本快照 |

后端补丁只适用于上述部署前 SHA-256 的 `server.js`。码包页的对比仅涉及请求脚本，没有改变 CSS、页面布局、动物图标或其他视觉内容；目前线上前端文件已是表中哈希，不能再用旧页面覆盖它。

网页版 `POST /api/code-packages` 现在必须携带 `Idempotency-Key`。服务端将请求键、请求内容摘要和码包 ID 持久关联；同键同参数的完成任务返回原码包及下载链接，不再新增任务或码，同键改参数拒绝。浏览器在提交前保存键和表单参数；网络响应不确定或刷新页面后，用原键重试，不自动开启新任务。处理中或生成失败的原任务不会被自动复制，需要先核查记录。

发布前使用独立临时数据库跑通 14 项隔离验收，含真实生成 50,000 个唯一单品码、链接 TXT Windows CRLF、丢失响应后重试、并发提交、服务重启后重试、失败生成、数量边界与权限隔离；临时数据已清除，没有往生产业务库写入测试码。发布后公网 `/readyz` 200 且 TLS 校验成功，管理员登录、受保护码包页、退出通过；无请求键的提交返回 `400 IDEMPOTENCY_KEY_REQUIRED`，此次线上验收未生成码包。

部署前在线备份和校验 SQLite 完整性，原文件及数据库留在服务器 `/root/traceability-system/backups/20260916-code-package-idempotency/`；服务由 PM2 `trace` 管理。只回滚代码时可从该目录恢复 `server.before.js` 与 `downloads.before.ejs` 并重启 PM2。**不要在业务已继续写入后直接覆盖当前数据库**；数据库恢复需要额外停写、评估和批准。

仍需由工厂用实际印刷软件验证 TXT 导入与试印。该验收与超时重试防重复是不同交付条件。
