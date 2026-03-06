#!/bin/bash

# QQBot 插件更新脚本
# 版本: 2.1 (仅更新插件版)
#
# 功能说明:
# 1. 备份已有 qqbot 通道配置
# 2. 移除老版本插件
# 3. 安装当前版本插件
# 4. 恢复或配置机器人通道
#
# 注意: 此脚本仅更新插件，不启动 openclaw
# 更新完成后需要手动重启 openclaw 服务以加载新插件
#
# 主要特性:
# 1. 详细的安装错误诊断和排查建议
# 2. 所有关键步骤的错误捕获和报告
# 3. 日志文件保存和错误摘要
# 4. 智能故障排查指南
# 5. 用户友好的交互提示

set -e

# 检查是否使用 sudo 运行（不建议）
if [ "$EUID" -eq 0 ]; then
    echo "⚠️  警告: 请不要使用 sudo 运行此脚本！"
    echo "   使用 sudo 会导致配置文件权限问题。"
    echo ""
    echo "请直接运行:"
    echo "   bash scripts/upgrade.sh"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# 解析命令行参数
APPID=""
SECRET=""

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
        -h|--help)
            echo "用法: $0 [选项]"
            echo ""
            echo "QQBot 插件更新脚本 - 更新 QQBot 插件到最新版本"
            echo ""
            echo "选项:"
            echo "  --appid <appid>       QQ机器人 AppID"
            echo "  --secret <secret>     QQ机器人 Secret"
            echo "  -h, --help            显示帮助信息"
            echo ""
            echo "也可以通过环境变量设置:"
            echo "  QQBOT_APPID           QQ机器人 AppID"
            echo "  QQBOT_SECRET          QQ机器人 Secret"
            echo "  QQBOT_TOKEN           QQ机器人 Token (AppID:Secret)"
            echo ""
            echo "不带参数时，将使用已有配置更新插件。"
            echo ""
            echo "注意: 插件更新后需要重启 OpenClaw 服务才能生效"
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

echo "========================================="
echo "  QQBot 插件更新脚本"
echo "========================================="

# 1. 备份已有 qqbot 通道配置，防止升级过程丢失
echo ""
echo "[1/4] 备份已有配置..."
SAVED_QQBOT_TOKEN=""
for APP_NAME in openclaw clawdbot; do
    CONFIG_FILE="$HOME/.$APP_NAME/$APP_NAME.json"
    if [ -f "$CONFIG_FILE" ]; then
        SAVED_QQBOT_TOKEN=$(node -e "
            const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
            const ch = cfg.channels && cfg.channels.qqbot;
            if (!ch) process.exit(0);
            // token 字段（openclaw channels add 写入）
            if (ch.token) { process.stdout.write(ch.token); process.exit(0); }
            // appId + clientSecret 字段（openclaw 实际存储格式）
            if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId + ':' + ch.clientSecret); process.exit(0); }
        " 2>/dev/null || true)
        if [ -n "$SAVED_QQBOT_TOKEN" ]; then
            echo "已备份 qqbot 通道 token: ${SAVED_QQBOT_TOKEN:0:10}..."
            break
        fi
    fi
done

# 2. 移除老版本
echo ""
echo "[2/4] 移除老版本..."
CLEANUP_SCRIPT="$(dirname "$0")/cleanup.sh"
if [ -f "$CLEANUP_SCRIPT" ]; then
    bash "$CLEANUP_SCRIPT"
else
    echo "警告: cleanup.sh 不存在，跳过清理步骤"
fi

# 3. 安装当前版本
echo ""
echo "[3/4] 安装当前版本..."

echo "检查当前目录: $(pwd)"
echo "检查openclaw版本: $(openclaw --version 2>/dev/null || echo 'openclaw not found')"

echo "开始安装插件..."
INSTALL_LOG="/tmp/openclaw-install-\$(date +%s).log"

echo "安装日志文件: $INSTALL_LOG"
echo "详细信息将记录到日志文件中..."

# 尝试安装并捕获详细输出
if ! openclaw plugins install . 2>&1 | tee "$INSTALL_LOG"; then
    echo ""
    echo "❌ 插件安装失败！"
    echo "========================================="
    echo "故障排查信息:"
    echo "========================================="
    
    # 分析错误原因
    echo "1. 检查日志文件末尾: $INSTALL_LOG"
    echo "2. 常见原因分析:"
    
    # 检查网络连接
    echo "   - 网络问题: 测试 npm 仓库连接"
    echo "     curl -I https://registry.npmjs.org/ || curl -I https://registry.npmmirror.com/"
    
    # 检查权限
    echo "   - 权限问题: 检查安装目录权限"
    echo "     ls -la ~/.openclaw/ 2>/dev/null || echo '目录不存在'"
    
    # 检查npm配置
    echo "   - npm配置: 检查当前npm配置"
    echo "     npm config get registry"
    
    # 显示错误摘要
    echo ""
    echo "3. 错误摘要:"
    tail -20 "$INSTALL_LOG" | grep -i -E "(error|fail|warn|npm install)"
    
    echo ""
    echo "4. 可选解决方案:"
    echo "   a. 更换npm镜像源:"
    echo "      npm config set registry https://registry.npmmirror.com/"
    echo "   b. 清理npm缓存:"
    echo "      npm cache clean --force"
    echo "   c. 手动安装依赖:"
    echo "      cd $(pwd) && npm install --verbose"
    
    echo ""
    echo "========================================="
    echo "建议: 先查看完整日志文件: cat $INSTALL_LOG"
    echo "或者尝试手动安装: cd $(pwd) && npm install"
    echo "========================================="
    
    read -p "是否继续配置其他步骤? (y/N): " continue_choice
    case "$continue_choice" in
        [Yy]* )
            echo "继续执行后续配置步骤..."
            ;;  
        * )
            echo "安装失败，脚本退出。"
            echo "请先解决安装问题后再运行此脚本。"
            exit 1
            ;;  
    esac
else
    echo ""
    echo "✅ 插件安装成功！"
    echo "安装日志已保存到: $INSTALL_LOG"
fi

# 4. 配置机器人通道（仅在提供了 appid/secret 时才配置，否则使用已有配置）
echo ""
echo "[4/4] 配置机器人通道..."

if [ -n "$APPID" ] && [ -n "$SECRET" ]; then
    QQBOT_TOKEN="${APPID}:${SECRET}"
    echo "使用提供的 AppID 和 Secret 配置..."
    echo "配置机器人通道: qqbot"
    echo "使用Token: ${QQBOT_TOKEN:0:10}..."

    if ! openclaw channels add --channel qqbot --token "$QQBOT_TOKEN" 2>&1; then
        echo ""
        echo "⚠️  警告: 机器人通道配置失败，但脚本将继续执行"
        echo "可能的原因:"
        echo "1. Token格式错误 (应为 AppID:Secret)"
        echo "2. OpenClaw未正确安装"
        echo "3. qqbot通道已存在"
        echo ""
        echo "您可以稍后手动配置: openclaw channels add --channel qqbot --token 'AppID:Secret'"
    else
        echo "✅ 机器人通道配置成功"
    fi
elif [ -n "$QQBOT_TOKEN" ]; then
    echo "使用环境变量 QQBOT_TOKEN 配置..."
    echo "使用Token: ${QQBOT_TOKEN:0:10}..."

    if ! openclaw channels add --channel qqbot --token "$QQBOT_TOKEN" 2>&1; then
        echo "⚠️  警告: 机器人通道配置失败，继续使用已有配置"
    else
        echo "✅ 机器人通道配置成功"
    fi
else
    # 未传参数，尝试用备份的 token 恢复通道配置
    if [ -n "$SAVED_QQBOT_TOKEN" ]; then
        echo "未提供 AppID/Secret，使用备份的 token 恢复配置..."
        if ! openclaw channels add --channel qqbot --token "$SAVED_QQBOT_TOKEN" 2>&1; then
            echo "⚠️  警告: 恢复通道配置失败，可能通道已存在"
        else
            echo "✅ 已从备份恢复 qqbot 通道配置"
        fi
    else
        echo "未提供 AppID/Secret，使用已有配置"
    fi
fi

# 完成
echo ""
echo "========================================="
echo "✅ 插件更新完成！"
echo "========================================="
echo ""
echo "插件已成功更新。如需启动 OpenClaw，请手动运行："
echo "  openclaw gateway --verbose"
echo ""
echo "或者如果 OpenClaw 已在运行，请重启服务以加载新插件："
echo "  openclaw gateway stop"
echo "  openclaw gateway --verbose"
echo ""
echo "========================================="
