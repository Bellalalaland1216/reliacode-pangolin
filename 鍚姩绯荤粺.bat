@echo off
chcp 65001 >nul
title 溯源码系统
echo ====================================
echo   正在启动溯源码系统...
echo   启动后请勿关闭此窗口
echo   管理后台: http://localhost:3000
echo ====================================
echo.

cd /d "%~dp0"

REM 检查依赖是否安装
if not exist node_modules (
  echo 首次运行，正在安装依赖，请稍候...
  call npm install
)

node server.js

echo.
echo 服务已停止，按任意键关闭窗口
pause >nul
