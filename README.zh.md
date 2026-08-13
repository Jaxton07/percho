<p align="center">
  <img src="docs/icon.svg" alt="percho logo" width="128">
</p>
<h1 align="center">percho</h1>
<p align="center">
  极简设计的 <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent">Pi coding agent</a> 桌面端 GUI —— 与 Pi CLI 同源同引擎，干净清爽的视觉界面。多会话聊天、可视化工具审批、自定义主题。
</p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Jaxton07/percho?style=flat-square" alt="License"></a>
  <a href="https://github.com/Jaxton07/percho/releases"><img src="https://img.shields.io/github/v/release/Jaxton07/percho?style=flat-square" alt="Release"></a>
  <a href="https://github.com/Jaxton07/percho/releases"><img src="https://img.shields.io/github/downloads/Jaxton07/percho/total?style=flat-square" alt="Downloads"></a>
  <a href="https://github.com/Jaxton07/percho/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Jaxton07/percho/ci.yml?style=flat-square" alt="CI"></a>
  <a href="https://github.com/Jaxton07/percho"><img src="https://img.shields.io/github/stars/Jaxton07/percho?style=flat-square" alt="Stars"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=nodedotjs&style=flat-square" alt="Node >=22.19">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue?style=flat-square" alt="macOS | Windows">
</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>

---

## 演示

![percho 聊天页截图](docs/assets/img/percho_chat_page.png)

**聊天页**

![聊天页演示](docs/assets/img/demo-chat.gif)

**自定义背景 + 深色主题**

![深色主题下带自定义背景的聊天页](docs/assets/img/chat_img_bg_show_img.png)

**设置页 —— 模型与 Provider**

![设置页演示](docs/assets/img/demo-settings.gif)

**设置页 —— 外观（主题与背景）**

![外观设置](docs/assets/img/settings_img_bg.png)

## 为什么选择 percho？

percho 把官方 Pi SDK（`@earendil-works/pi-coding-agent`）跑在 Electron 主进程里。**不是 fork，也不是重新实现** —— 它和 Pi CLI 用的是同一套引擎，完整继承 Pi 的原生优势：

- **可扩展性** —— 为 Pi CLI 安装的 TypeScript 扩展、Skills、Prompt 模板在这里同样生效，包括项目级资源（加载前会有信任确认）。让 Pi 适应你的工作流，无需 fork。
- **配置共享** —— 与 CLI 共用 `~/.pi/agent/` 目录：会话、认证、模型配置全部互通。终端里开的会话，可以在 GUI 里继续。
- **模型来源** —— 支持订阅（Claude Pro/Max、ChatGPT Plus/Pro Codex、GitHub Copilot）以及 Anthropic、OpenAI、Gemini、DeepSeek、Bedrock 等 API key。

同时，为更喜欢图形界面的用户提供：

- 极简设计美学 —— 界面保持 Pi 一贯的清爽干净，不堆砌元素
- 可视化权限审批 —— 在底部审批坞里逐个批准/拒绝工具调用，背后是逐工具的规则引擎
- 多会话侧栏、逐会话输入草稿、可撤销的跟进消息队列
- 流式 Markdown 渲染、图片预览、消息复制
- Agent 主动发图 —— 内置 `show_image` 工具让 agent 在需要时把图片（单张或成组）直接显示到对话区，而不是把所有工具结果都变成噪音
- 自定义背景图与遮罩透明度，浅色/深色/跟随系统主题

## 下载

预编译安装包发布在 [Releases](https://github.com/Jaxton07/percho/releases) 页面。

| 平台 | 下载 |
| --- | --- |
| macOS (Apple Silicon) | `percho-mac-arm64.dmg` |
| macOS (Intel) | `percho-mac-x64.dmg` |
| Windows | `percho-windows-x64.exe` |

> 构建为 adhoc 临时签名（无 Developer ID 证书）。macOS 下载后首次打开可能提示**「Apple 无法验证 Percho 是否包含危害 Mac 安全或泄漏隐私的恶意软件」**—— 这是 Gatekeeper 拦截未公证的 App。按以下方式放行：
>
> 1. **系统设置 → 隐私与安全性** → 滚动到底部 → 在 Percho 条目旁点**「仍要打开」**，然后输入密码或 Touch ID 确认（推荐）。
>
>    ![macOS「仍要打开」](docs/assets/img/percho_mac_permission.png)
>
> 2. 或在终端执行：`xattr -cr "/Applications/Percho.app"`。
>
> 每个下载版本只需首次打开时放行一次——之后自动更新在应用内完成，不会再触发 Gatekeeper。Windows 上 SmartScreen 提示时点「更多信息」→「仍要运行」。

## 配置

API key 不会存入本仓库，也不会打进安装包。`~/.pi/agent/models.json` 通过环境变量引用（如 `$AI_OPS_API_KEY`），key 只存在于你的 shell 环境中。如果你已经在用 Pi CLI，现有配置开箱即用。

## 开发

前置要求：**Node.js >= 22.19**。

```bash
npm install
npm run dev
```

npm workspaces monorepo，三个包：`packages/shared`（IPC 契约）、`packages/backend`（唯一 import Pi SDK 的地方）、`packages/desktop`（Electron + React 19 + Tailwind 4 + Zustand）。常用命令：`npm run typecheck` / `test` / `lint` / `build` / `dist`。

完整指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。国内下载 Electron 二进制太慢的话，先设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

## 声明

percho 是社区项目，**并非** Pi 团队（earendil-works）官方出品，也与其无任何隶属关系。

## License

[MIT](LICENSE)
