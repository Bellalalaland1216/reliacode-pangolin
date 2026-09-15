#!/bin/bash
# 溯源系统一键部署脚本（Debian 13 / Ubuntu，root 或普通用户均可）
# 用法：在项目目录下执行  bash setup.sh
set -e

# root 环境下不需要 sudo
SUDO=""
if [ "$(id -u)" != "0" ]; then
  SUDO="sudo"
fi

echo "==> [1/5] 安装基础软件（nodejs npm unzip） ..."
$SUDO apt-get update -qq
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm unzip >/dev/null
echo "    Node.js 版本: $(node -v)"

echo "==> [2/5] 配置国内镜像加速 ..."
npm config set registry https://registry.npmmirror.com
export npm_config_better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3

echo "==> [3/5] 安装项目依赖 ..."
npm install --omit=dev --no-audit --no-fund

echo "==> [4/5] 安装 pm2 进程守护 ..."
if ! command -v pm2 >/dev/null 2>&1; then
  $SUDO npm install -g pm2 --registry=https://registry.npmmirror.com
fi

echo "==> [5/5] 启动服务并设置开机自启 ..."
pm2 delete trace 2>/dev/null || true
pm2 start server.js --name trace
pm2 save
$SUDO env PATH=$PATH:/usr/bin pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 || true

SERVER_IP=$(curl -s -m 5 ifconfig.me || hostname -I | awk '{print $1}')
echo ""
echo "========================================================"
echo "  部署完成！"
echo "  管理后台:  http://${SERVER_IP}:3000/"
echo "  手机验证:  http://${SERVER_IP}:3000/verify"
echo "  常用命令:  pm2 logs trace   查看日志"
echo "             pm2 restart trace 重启"
echo "             pm2 stop trace    停止"
echo "========================================================"
echo "  提醒: 请在云服务器控制台的防火墙/安全组中放行 3000 端口"
