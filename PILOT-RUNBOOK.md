# ReliaCode 单公司生产试点运行手册

## 已启用的保护

- Nginx 对外提供 80/443，Node 仅监听 `127.0.0.1:3000`。
- PM2 以 `NODE_ENV=production` 运行，生产会话使用安全 Cookie。
- systemd 每日执行一致性 SQLite 与附件备份，保留 14 天。
- systemd 每月在临时目录执行一次非破坏恢复演练。
- systemd 每 5 分钟检查本机 HTTP、公网 HTTPS、磁盘使用率、备份新鲜度和 SQLite 完整性。
- 所有新建账号、管理员重置密码和用户自行修改密码均要求至少 12 位，并同时包含字母、数字和特殊字符。

## 日常检查

```bash
systemctl status reliacode-health.timer reliacode-backup.timer reliacode-restore-drill.timer
cat /var/lib/reliacode-ops/health-last.env
cat /var/lib/reliacode-ops/restore-drill-last.env
journalctl -u reliacode-health.service -n 100 --no-pager
pm2 status
```

## 告警接收

在 `/etc/reliacode/pilot-ops.env` 中配置一个企业微信、钉钉或兼容 JSON Webhook：

```bash
ALERT_WEBHOOK_URL=https://example.invalid/webhook
```

不配置 Webhook 时，检查失败仍会令 systemd 服务失败并写入 journal，但不会向外部联系人发送消息。

## 异地备份

本机备份不能代替异地备份。创建专用对象存储桶和最小权限凭据、安装并配置 rclone 后，在
`/etc/reliacode/pilot-ops.env` 设置：

```bash
OFFSITE_RCLONE_REMOTE=reliacode-oss:reliacode-pilot-backups
```

使用 `ops/offsite-sync.sh` 上传后会执行远端校验。没有实际远端配置时，脚本会失败退出，禁止把本机副本误报为异地备份。

## 现场验收

试点负责人必须使用实际标签打印机和员工手机完成并签字：

1. 批量生码并下载码包。
2. 打印箱码和子码，抽检二维码清晰度及内容。
3. 装箱并验证重复扫码被拒绝。
4. 发货并验证重复发货被拒绝。
5. 使用微信或手机浏览器公开验证，确认产品、批次和状态正确。
6. 记录打印机型号、纸张规格、扫码设备、执行人、时间和异常。

软件自动化测试不能替代这一步物理验收。

## 多品牌演进边界

当前 SQLite 版本只用于单公司受控试点。虽然已有品牌字段和应用层隔离，未来对多个独立品牌商用前，必须迁移到主仓库的 PostgreSQL 多租户架构，启用数据库级隔离、幂等业务命令、追加式事件及审计、异步生码和 OpenEPCIS 交付。不得直接把本试点数据库复制为通用 SaaS。
