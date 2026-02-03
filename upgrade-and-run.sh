#!/bin/bash

# QQBot 一键更新并启动脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================="
echo "  QQBot 一键更新启动脚本"
echo "========================================="

# 1. 移除老版本
echo ""
echo "[1/4] 移除老版本..."
if [ -f "./scripts/upgrade.sh" ]; then
    bash ./scripts/upgrade.sh
else
    echo "警告: upgrade.sh 不存在，跳过移除步骤"
fi

# 2. 安装当前版本
echo ""
echo "[2/4] 安装当前版本..."
openclaw plugins install .

# 3. 配置机器人通道
echo ""
echo "[3/4] 配置机器人通道..."
# 默认 token，可通过环境变量 QQBOT_TOKEN 覆盖
QQBOT_TOKEN="${QQBOT_TOKEN:-appid:secret}"
openclaw channels add --channel qqbot --token "$QQBOT_TOKEN"
# 启用 markdown 支持
openclaw config set channels.qqbot.markdownSupport true

# 4. 启动 openclaw
echo ""
echo "[4/4] 启动 openclaw..."
echo "========================================="
openclaw gateway --verbose
