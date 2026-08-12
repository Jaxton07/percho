<p align="center">
  <img src="docs/icon.svg" alt="pi-desktop logo" width="128">
</p>
<h1 align="center">pi-desktop</h1>
<p align="center">
  Minimalist desktop GUI for the <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent">Pi coding agent</a> — the same engine as the Pi CLI, in a clean visual interface. Multi-session chat, visual tool approvals, and custom themes.
</p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Jaxton07/pi-desktop?style=flat-square" alt="License"></a>
  <a href="https://github.com/Jaxton07/pi-desktop/releases"><img src="https://img.shields.io/github/v/release/Jaxton07/pi-desktop?style=flat-square" alt="Release"></a>
  <a href="https://github.com/Jaxton07/pi-desktop/releases"><img src="https://img.shields.io/github/downloads/Jaxton07/pi-desktop/total?style=flat-square" alt="Downloads"></a>
  <a href="https://github.com/Jaxton07/pi-desktop/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Jaxton07/pi-desktop/ci.yml?style=flat-square" alt="CI"></a>
  <a href="https://github.com/Jaxton07/pi-desktop"><img src="https://img.shields.io/github/stars/Jaxton07/pi-desktop?style=flat-square" alt="Stars"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=nodedotjs&style=flat-square" alt="Node >=22.19">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue?style=flat-square" alt="macOS | Windows">
</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>

---

## Demo

![pi-desktop chat page](docs/assets/img/pi_desktop_chat_page.png)

**Chat**

![Chat page demo](docs/assets/img/demo-chat.gif)

**Custom background & dark theme**

![Chat with custom background image in dark theme](docs/assets/img/chat_img_bg_show_img.png)

**Settings — providers & models**

![Settings page demo](docs/assets/img/demo-settings.gif)

**Settings — appearance (theme & background)**

![Appearance settings](docs/assets/img/settings_img_bg.png)

## Why pi-desktop?

pi-desktop embeds the official Pi SDK (`@earendil-works/pi-coding-agent`) in the Electron main process. It is **not a fork and not a reimplementation** — it runs the same engine as the Pi CLI and inherits Pi's native strengths:

- **Extensibility** — TypeScript extensions, skills, and prompt templates installed for the Pi CLI work here too, including project-local ones (with a trust prompt before loading). Adapt Pi to your workflows, no forking required.
- **Shared configuration** — same `~/.pi/agent/` directory as the CLI: sessions, auth, and model settings carry over. Start a session in the terminal, continue it in the GUI.
- **Providers** — subscriptions (Claude Pro/Max, ChatGPT Plus/Pro Codex, GitHub Copilot) and API keys for Anthropic, OpenAI, Gemini, DeepSeek, Bedrock, and more.

And for those who prefer a GUI over a TUI:

- Minimalist by design — a clean, uncluttered interface that stays true to Pi's aesthetic
- Visual permission gates — approve or deny each tool call from a dock, backed by a per-tool rule engine
- Multi-session sidebar, per-session composer drafts, follow-up queue with undo
- Streaming markdown rendering, image previews, message copy
- Agent-initiated image display — a built-in `show_image` tool lets the agent deliberately show you images inline (single or grouped), without turning every tool result into noise
- Custom background image with adjustable overlay dimming, light/dark/system themes

## Download

Prebuilt installers are published on the [Releases](https://github.com/Jaxton07/pi-desktop/releases) page.

| Platform | Download |
| --- | --- |
| macOS (Apple Silicon) | `pi-desktop-mac-arm64.dmg` |
| macOS (Intel) | `pi-desktop-mac-x64.dmg` |
| Windows | `pi-desktop-windows-x64.exe` |

> Builds are ad-hoc signed (no Developer ID certificate). On macOS, the first launch after a download may show **"Apple cannot verify Pi Desktop is free from malware"** — that's Gatekeeper blocking an un-notarized app. To open it:
>
> 1. **System Settings → Privacy & Security** → scroll to the bottom → click **Open Anyway** next to the Pi Desktop entry, then confirm with your password or Touch ID (recommended).
>
>    ![macOS Open Anyway](docs/assets/img/pi_desk_mac_permission.png)
>
> 2. Or in Terminal: `xattr -cr "/Applications/Pi Desktop.app"`.
>
> Only the first launch of each downloaded version needs this — later updates install automatically in-app and skip Gatekeeper entirely. On Windows, click "More info" → "Run anyway" when SmartScreen appears.

## Configuration

API keys are never stored in this repo or written into the app bundle. `~/.pi/agent/models.json` references environment variables (e.g. `$AI_OPS_API_KEY`) and keys stay in your shell environment. If you already use the Pi CLI, your existing setup just works.

## Development

Prerequisites: **Node.js >= 22.19**.

```bash
npm install
npm run dev
```

npm workspaces monorepo, three packages: `packages/shared` (IPC contracts), `packages/backend` (the only place that imports the Pi SDK), `packages/desktop` (Electron + React 19 + Tailwind 4 + Zustand). Common commands: `npm run typecheck` / `test` / `lint` / `build` / `dist`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide. If you are in China and the Electron binary download stalls, set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` first.

## Disclaimer

pi-desktop is a community project. It is **not** built by or affiliated with the Pi team (earendil-works).

## License

[MIT](LICENSE)
