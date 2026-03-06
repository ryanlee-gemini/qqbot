# Scripts 目录说明

本目录包含 QQBot 插件的管理和工具脚本。

## 🔧 Shell 脚本

### upgrade.sh
**插件更新脚本** - 用于更新 QQBot 插件到最新版本

**功能：**
- 备份已有配置
- 清理旧版本（调用 cleanup.sh）
- 安装新版本
- 恢复或配置机器人通道

**用法：**
```bash
# 基本用法（从项目根目录执行）
bash scripts/upgrade.sh

# 指定 AppID 和 Secret
bash scripts/upgrade.sh --appid YOUR_APPID --secret YOUR_SECRET

# 使用环境变量
export QQBOT_APPID="YOUR_APPID"
export QQBOT_SECRET="YOUR_SECRET"
bash scripts/upgrade.sh

# 查看帮助
bash scripts/upgrade.sh --help
```

**注意：** 更新后需要重启 OpenClaw 服务以加载新插件

---

### cleanup.sh
**插件清理脚本** - 用于清理旧版本插件和配置

**功能：**
- 删除旧的插件目录
- 清理配置文件中的 qqbot 相关字段
- 支持 openclaw 和 clawdbot 两种安装方式

**用法：**
```bash
bash scripts/cleanup.sh
```

**使用场景：**
- 重新安装插件前
- 清理损坏的插件安装
- 重置插件配置

---

### set-markdown.sh
**Markdown 配置脚本** - 用于配置 QQBot 的 Markdown 消息格式

**功能：**
- 启用/禁用 Markdown 消息格式
- 查看当前 Markdown 状态
- 交互式配置

**用法：**
```bash
# 启用 Markdown
bash scripts/set-markdown.sh enable

# 禁用 Markdown
bash scripts/set-markdown.sh disable

# 查看当前状态
bash scripts/set-markdown.sh status

# 交互式选择
bash scripts/set-markdown.sh
```

**注意：** 启用 Markdown 需要在 QQ 开放平台申请 Markdown 消息权限

---

## 📝 TypeScript 脚本

### proactive-api-server.ts
**主动消息 API 服务器** - 提供 HTTP API 接口用于主动发送消息

**功能：**
- 提供 RESTful API 接口
- 支持主动向用户/群组发送消息
- 适用于定时任务、外部系统集成等场景

**用法：**
```bash
# 需要先编译或使用 ts-node 运行
ts-node scripts/proactive-api-server.ts
```

---

### send-proactive.ts
**主动消息发送工具** - 命令行工具，用于发送主动消息

**功能：**
- 命令行方式发送消息
- 支持发送到指定用户或群组
- 适用于测试和脚本自动化

**用法：**
```bash
# 需要先编译或使用 ts-node 运行
ts-node scripts/send-proactive.ts --target USER_ID --message "Hello"
```

---

## 🔗 相关文档

- [完整命令手册](../docs/commands.md)
- [主 README](../README.md)
- [中文 README](../README.zh.md)

---

## ⚠️ 注意事项

1. **不要使用 sudo**：运行脚本时不要使用 sudo，会导致配置文件权限问题
2. **从项目根目录执行**：所有脚本应该从项目根目录执行（而不是在 scripts 目录内）
3. **重启服务**：更新插件或配置后，需要重启 OpenClaw 服务才能生效
4. **备份配置**：在进行清理或更新操作前，建议手动备份重要配置

---

## 📚 更多帮助

如需更多帮助，请参考：
- [OpenClaw 文档](https://github.com/sliverp/openclaw)
- [QQ 开放平台文档](https://bot.q.qq.com/wiki/)
