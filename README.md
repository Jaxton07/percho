<p align="center">
  <img src="docs/icon.svg" alt="pi-desktop logo" width="128">
</p>
<h1 align="center">pi-desktop</h1>
<p align="center">
  A desktop GUI for the <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent">Pi coding agent</a> — Pi's power and extensibility, with a visual interface.
</p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Jaxton07/pi-desktop?style=flat-square" alt="License"></a>
</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>

---

## Demo

![pi-desktop chat page](docs/pi_desktop_chat_page.png)

**Chat**

![Chat page demo](docs/demo-chat.gif)

**Settings — providers & models**

![Settings page demo](docs/demo-settings.gif)

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

## Download

Prebuilt installers are published on the [Releases](https://github.com/Jaxton07/pi-desktop/releases) page.

| Platform | Download |
| --- | --- |
| macOS (Apple Silicon) | `pi-desktop-mac-arm64.dmg` |
| macOS (Intel) | `pi-desktop-mac-x64.dmg` |
| Windows | `pi-desktop-windows-x64.exe` |

> Builds are currently unsigned. On macOS, the first launch may show **"pi-desktop is damaged and can't be opened"** — that's Gatekeeper blocking an unsigned download, not actual damage. Fix it by removing the quarantine flag: `xattr -cr /Applications/pi-desktop.app`, then open normally. On Windows, click "More info" → "Run anyway" when SmartScreen appears.

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
