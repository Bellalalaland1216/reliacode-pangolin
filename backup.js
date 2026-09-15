// 每日自动备份脚本（由服务器 cron 调用）
// 用 SQLite 在线备份 API 生成一致性快照，保留最近 14 份
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data', 'traceability.db');
const BACKUP_DIR = path.join(ROOT, 'data', 'backups');
const KEEP = 14;

(async () => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const db = new Database(DB_PATH, { readonly: true });
  // 文件名使用本地时间（服务器时区 Asia/Shanghai）
  const n = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const stamp = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}-${pad(n.getHours())}-${pad(n.getMinutes())}-${pad(n.getSeconds())}`;
  const target = path.join(BACKUP_DIR, `traceability-${stamp}.db`);
  await db.backup(target);
  db.close();

  // 清理旧备份，只保留最近 KEEP 份
  const files = fs.readdirSync(BACKUP_DIR).filter(f => /^traceability-[\w-]+\.db$/.test(f)).sort();
  while (files.length > KEEP) {
    fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  }
  console.log(`[backup] ${target} 完成，当前共 ${files.length} 份备份`);
})().catch(err => {
  console.error('[backup] 失败:', err.message);
  process.exit(1);
});
