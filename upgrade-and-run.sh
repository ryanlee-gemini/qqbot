#!/bin/bash

# QQBot 一键更新并启动脚本

set -e

# 检查是否使用 sudo 运行（不建议）
if [ "$EUID" -eq 0 ]; then
    echo "⚠️  警告: 请不要使用 sudo 运行此脚本！"
    echo "   使用 sudo 会导致配置文件权限问题。"
    echo ""
    echo "请直接运行:"
    echo "   ./upgrade-and-run.sh"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 解析命令行参数
APPID=""
SECRET=""
MARKDOWN=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --appid)
            APPID="$2"
            shift 2
            ;;
        --secret)
            SECRET="$2"
            shift 2
            ;;
        --markdown)
            MARKDOWN="$2"
            shift 2
            ;;
        -h|--help)
            echo "用法: $0 [选项]"
            echo ""
            echo "选项:"
            echo "  --appid <appid>       QQ机器人 AppID"
            echo "  --secret <secret>     QQ机器人 Secret"
            echo "  --markdown <yes|no>   是否启用 Markdown 消息格式（默认: no）"
            echo "  -h, --help            显示帮助信息"
            echo ""
            echo "也可以通过环境变量设置:"
            echo "  QQBOT_APPID           QQ机器人 AppID"
            echo "  QQBOT_SECRET          QQ机器人 Secret"
            echo "  QQBOT_MARKDOWN        是否启用 Markdown（yes/no）"
            echo ""
            echo "⚠️  注意: 启用 Markdown 需要在 QQ 开放平台申请 Markdown 消息权限"
            exit 0
            ;;
        *)
            echo "未知选项: $1"
            echo "使用 --help 查看帮助信息"
            exit 1
            ;;
    esac
done

# 使用命令行参数或环境变量
APPID="${APPID:-$QQBOT_APPID}"
SECRET="${SECRET:-$QQBOT_SECRET}"
MARKDOWN="${MARKDOWN:-$QQBOT_MARKDOWN}"

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

# 构建 token（如果提供了 appid 和 secret）
if [ -n "$APPID" ] && [ -n "$SECRET" ]; then
    QQBOT_TOKEN="${APPID}:${SECRET}"
    echo "使用提供的 AppID 和 Secret 配置..."
else
    # 默认 token，可通过环境变量 QQBOT_TOKEN 覆盖
    QQBOT_TOKEN="${QQBOT_TOKEN:-appid:secret}"
    echo "使用默认或环境变量中的 Token..."
fi

openclaw channels add --channel qqbot --token "$QQBOT_TOKEN"

# 5. 配置 Markdown 选项
echo ""
echo "[4/4] 配置 Markdown 选项..."

# 如果没有通过参数或环境变量指定，询问用户
if [ -z "$MARKDOWN" ]; then
    echo ""
    echo "是否启用 Markdown 消息格式？"
    echo "⚠️  注意: 启用 Markdown 需要在 QQ 开放平台申请 Markdown 消息权限"
    echo "         如果没有权限，消息将无法正常发送！"
    echo ""
    read -p "启用 Markdown? (y/N): " md_choice
    case "$md_choice" in
        [Yy]* )
            MARKDOWN="yes"
            ;;
        * )
            MARKDOWN="no"
            ;;
    esac
fi

# 设置 markdown 配置
if [ "$MARKDOWN" = "yes" ] || [ "$MARKDOWN" = "y" ] || [ "$MARKDOWN" = "true" ]; then
    echo "启用 Markdown 消息格式..."
    openclaw config set qqbot.markdownSupport true 2>/dev/null || true
else
    echo "禁用 Markdown 消息格式（使用纯文本）..."
    openclaw config set qqbot.markdownSupport false 2>/dev/null || true
fi

# 6. 启动 openclaw
echo ""
echo "[5/5] 启动 openclaw..."
echo "========================================="
openclaw gateway --verbose
