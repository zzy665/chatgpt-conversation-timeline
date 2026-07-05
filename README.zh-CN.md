<p align="center">
  <img src="public/preview.png" alt="对话时间轴预览">
</p>

# ChatGPT 对话时间轴

> English README: [README.md](./README.md)

这是一个浏览器扩展，用来给 AI 聊天网页添加对话时间轴。本修改版主要针对 ChatGPT 网页版和 `mana-x.aizex.net` ChatGPT 中转站做了适配与样式改造：右侧显示类似 ChatGPT/Codex 的短横条时间线，鼠标靠近时按距离展开，方便在长对话里快速预览和跳转。

它适合经常阅读长对话、需要回看某个问题、标记重点轮次，或者想快速理解整段对话结构的人。

## 功能

- **Codex 风格横条时间线**：每个用户问题显示为右侧短横条，而不是传统圆点。
- **快速悬停展开**：鼠标靠近时，最近的对话条最长，两侧按距离阶梯状缩短，并保持右对齐。
- **问题与回答预览**：提示框中分开展示用户问题和模型回答片段；类似 `思考 8 秒` 的前缀会加粗显示，不再显示“模型说/大模型说”这类多余前缀。
- **点击跳转**：点击任意时间条即可跳转到对应用户消息。
- **本地重点标记**：长按时间条可以标记重点，对应标记会保存在浏览器本地。
- **按站点开关**：弹窗里可以全局启用/关闭，也可以单独控制每个支持的网站。
- **自动适配主题**：跟随支持网站的浅色/深色主题。
- **交互性能优化**：鼠标移动时使用缓存位置、有限范围重绘和 `transform` 缩放，减少布局计算，让时间条变化更跟手。

## 支持网站

- ChatGPT：`https://chatgpt.com/*`
- 旧版 ChatGPT：`https://chat.openai.com/*`
- mana-x ChatGPT 中转：`https://mana-x.aizex.net/*`
- DeepSeek：`https://chat.deepseek.com/*`
- Gemini：`https://gemini.google.com/*`

其中，Codex 风格横条时间线和 mana-x 适配主要针对 ChatGPT/mana-x 路径；DeepSeek 和 Gemini 仍保留原有时间轴实现。

## 从源码安装

1. 下载或克隆本仓库。
2. 打开 Chrome 或 Edge，进入 `chrome://extensions/`。
3. 开启右上角的「开发者模式」。
4. 点击「加载已解压的扩展程序」。
5. 选择本仓库中的 `extension/` 文件夹。

安装后打开支持的聊天页面。如果该站点在扩展弹窗里处于启用状态，右侧会出现对话时间轴。

## 使用方式

- 鼠标靠近右侧时间线，附近对话条会自动展开。
- 点击对话条，跳转到对应用户问题。
- 长按对话条，标记或取消标记重点轮次。
- 在扩展弹窗里控制全局开关和各站点开关。

## 这个修改版做了什么

- 增加 `mana-x.aizex.net` 支持。
- 将 ChatGPT/mana-x 的时间线改成更接近当前 ChatGPT/Codex 的紧凑横条样式。
- 改进悬停逻辑：被选中的条最长，两侧根据距离阶梯状缩短。
- 提示框改为展示更多问题内容，并显示一部分模型回答。
- 移除“模型说/大模型说”等前缀，规范显示“思考 X 秒”。
- 调整当前对话、悬停状态、重点标记的视觉表现，避免粗重黑框。
- 优化鼠标移动性能：不再在每次移动时遍历读取所有条的位置，只重绘受影响的一小段时间条。

## 隐私说明

扩展在浏览器本地运行。它会读取当前页面中可见的对话 DOM 来生成时间轴，并使用浏览器存储保存扩展开关和重点标记 ID。本修改版没有加入统计、追踪，也不会把对话内容发送到远程服务。

## 开发检查

当前使用的轻量检查命令：

```powershell
node --check extension\content-chatgpt.js
node --check extension\chatgpt-initial-jump-utils.js
node --check extension\fiber-bridge-chatgpt.js
.\tests\run-node-tests.ps1
```

## 开源协议

MIT License，详见 [LICENSE](LICENSE)。
