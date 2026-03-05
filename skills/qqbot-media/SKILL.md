---
name: qqbot-media
description: QQBot 图片/语音/视频/文件收发能力。用户发来的图片自动下载到本地，发送图片使用 <qqimg> 标签，发送语音使用 <qqvoice> 标签，发送视频使用 <qqvideo> 标签，发送文件使用 <qqfile> 标签。当通过 QQ 通道通信时使用此技能。
metadata: {"openclaw":{"emoji":"📸","requires":{"config":["channels.qqbot"]}}}
---

# QQBot 图片/语音/视频/文件收发

## 标签速查（直接复制使用）

| 类型 | 标签格式 | 示例 |
|------|----------|------|
| 图片 | `<qqimg>绝对路径或URL</qqimg>` | `<qqimg>/tmp/pic.jpg</qqimg>` |
| 语音 | `<qqvoice>绝对路径</qqvoice>` | `<qqvoice>/tmp/voice.mp3</qqvoice>` |
| 视频 | `<qqvideo>绝对路径或URL</qqvideo>` | `<qqvideo>/tmp/video.mp4</qqvideo>` |
| 文件 | `<qqfile>绝对路径或URL</qqfile>` | `<qqfile>/tmp/doc.pdf</qqfile>` |

**标签拼写必须严格按上表**，只有这 4 个标签名：`qqimg`、`qqvoice`、`qqvideo`、`qqfile`。

## 发送图片

使用 `<qqimg>` 标签包裹路径即可发送图片（本地路径或网络 URL）：

```
<qqimg>/path/to/image.jpg</qqimg>
<qqimg>https://example.com/image.png</qqimg>
```

支持格式：jpg, jpeg, png, gif, webp, bmp。支持 `</qqimg>` 或 `</img>` 闭合。

## 接收图片

用户发来的图片**自动下载到本地**，路径在上下文【会话上下文 → 附件】中。
可直接用 `<qqimg>路径</qqimg>` 回发。历史图片在 `~/.openclaw/qqbot/downloads/` 下。

## 发送语音

使用 `<qqvoice>` 标签包裹**已有的本地音频文件路径**即可发送语音：

```
<qqvoice>/tmp/tts/voice.mp3</qqvoice>
```

注意：语音发送需要有可用的音频文件（通常由 TTS 工具生成）。**如果会话上下文中的【语音消息说明】提示 TTS 未配置，则不要使用 `<qqvoice>` 标签。**

## 发送视频

使用 `<qqvideo>` 标签包裹**视频路径或公网 URL** 即可发送视频：

```
<qqvideo>/path/to/video.mp4</qqvideo>
<qqvideo>https://example.com/video.mp4</qqvideo>
```

支持本地文件路径（系统自动读取上传）和公网 HTTP/HTTPS URL。

## 发送文件

使用 `<qqfile>` 标签包裹路径即可发送文件（本地路径或网络 URL）：

```
<qqfile>/path/to/report.pdf</qqfile>
<qqfile>https://example.com/data.xlsx</qqfile>
```

适用于非图片非语音的文件类型，如 pdf, docx, xlsx, zip, txt 等。

## ⚠️ 关键注意事项（必须遵守）

1. **必须使用绝对路径**：标签内的路径必须是绝对路径（以 `/` 开头），禁止使用相对路径如 `./pic.jpg`
   - ❌ 错误：`<qqimg>./pic.jpg</qqimg>`
   - ✅ 正确：`<qqimg>/Users/james23/.openclaw/workspace/pic.jpg</qqimg>`
2. **标签格式必须完整**：`<qqimg>` 开头和 `</qqimg>` 结尾都不能少，不能漏掉 `<` 符号
   - ❌ 错误：`qqimg>./pic.jpg</qqimg>`
   - ✅ 正确：`<qqimg>/absolute/path/to/pic.jpg</qqimg>`
3. **工作空间路径**：当前工作空间为 `/Users/james23/.openclaw/workspace/`，文件路径应基于此拼接绝对路径
4. **标签必须单独成行或前后有空格**，不要嵌入在句子中间
5. **文件大小限制**：上传文件（图片、语音、视频、文件）最大不超过 **20MB**

## 规则

- ⚠️ **禁止使用 message tool 发送图片/文件**，直接在回复文本中写对应标签即可，系统自动处理
- **永远不要说**"无法发送图片"或"无法访问之前的图片"
- 直接使用对应标签，不要只输出路径文本
- 标签外的文字会作为消息正文一起发送
- 多个媒体使用多个标签，图片用 `<qqimg>`，语音用 `<qqvoice>`，视频用 `<qqvideo>`，文件用 `<qqfile>`
- **以会话上下文中的能力说明为准**，如果提示语音未启用，不要尝试发送语音

## JSON 结构化载荷（高级）

```
QQBOT_PAYLOAD:
{"type":"media","mediaType":"image","source":"file","path":"/path/to/image.jpg","caption":"可选描述"}
{"type":"media","mediaType":"file","source":"file","path":"/path/to/doc.pdf","caption":"可选描述"}
```
