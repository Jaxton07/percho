# Contributing

Thanks for your interest in contributing! This document covers the development workflow and the conventions that keep this project maintainable.

## Getting started

1. Fork the repository and clone your fork.
2. Install **Node.js >= 22.19**.
3. Install dependencies and start the app:

```bash
npm install
npm run dev
```

If you are in China and the Electron binary download stalls, set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` first.

## Pull request workflow

1. Create a branch from `main` (`feat/...`, `fix/...`).
2. Make your changes.
3. Before opening the PR, make sure all of these pass locally:

```bash
npm run lint
npm run typecheck
npm run test
```

4. Open a PR against `main`. CI runs the same checks and must be green before merge.
5. PRs are merged with squash merge, so don't worry about a messy local history — but do write a clear PR title, since it becomes the commit message.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat: ...`, `fix: ...`, `refactor: ...`, `docs: ...`, `test: ...`, `chore: ...`.

## Project conventions

These are hard-won lessons — please follow them:

- **Formatting** is enforced by Biome: tabs, double quotes, line width 110. Run `npm run lint` instead of hand-formatting.
- **Renderer never imports Pi packages.** It only talks to the main process through `window.pi` (preload contextBridge). Channel definitions live in `packages/shared/src/ipc.ts`.
- **`packages/backend/src/pi-backend.ts` is the only file** allowed to import the Pi SDK (`@earendil-works/*`). SDK versions are pinned — don't upgrade casually.
- **i18n**: all user-facing strings go through `useT()` and must be added to **both** the `zh` and `en` dictionaries in `packages/desktop/src/renderer/src/i18n/`.
- **Zustand selectors must return stable references** (module-level constants for empty values). Inline `?? []` creates a new array every call and causes infinite render loops.
- **Never commit API keys or secrets.** `models.json` uses environment variable references (`$AI_OPS_API_KEY`); keys live in your shell environment only.

## Architecture pointers

- Multi-session support: `SessionRegistry` (`packages/backend/src/session-registry.ts`) holds multiple `AgentSession` instances.
- Permission prompts are injected via `session.bindExtensions(...)` — only modify the `confirm` handler in `makeUiContext`, don't rewrite the whole UI context.
- The preload bundle must stay CJS (`format: "cjs"`, `index.cjs`) or sandboxed renderers won't load it.

## Reporting bugs

Open an issue with the bug report template. Include your OS, app version, and steps to reproduce. Never paste API keys, session files, or `auth.json` contents into issues.
