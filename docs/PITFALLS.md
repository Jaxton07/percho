# Percho 踩坑记录（来之不易，勿重踩）

> **遇到怪问题先来这里查**：疑难 bug、构建/打包异常、SDK 行为反直觉——先按下方「症状快速索引」找条目，再决定要不要自己踩一遍。
> 配套阅读：`docs/INDEX.md`（项目索引，「想改 X 改哪里」）；AGENTS.md「UI 截图调试」「常用命令·本地内测打包」两节还有各自的实操坑。
> 新踩的坑记到这边（注明日期与修复点），别只在会话里说。

## 症状快速索引

| 症状 / 场景 | 条目（章节） |
|---|---|
| 全 app 卡死、日志/磁盘分钟级 GB 暴涨、renderer unresponsive | 一 · 0.4.6 冻结事故 |
| 流式期间白屏、`error #185`、无限重渲染整树卸载 | 一 · 0.5.0 白屏事故；四 · Zustand selector（#185 另一成因） |
| 扩展注册的工具模型用不了、模型说「工具列表为 none」 | 二 · createAgentSession tools 白名单 |
| 设置页永久 Loading、模型列表为空 | 二 · runtime.refresh 网络挂起 / getAvailable 返回空 |
| 权限 confirm 弹窗不生效 | 二 · bindExtensions 注入点 |
| preload 加载失败（sandbox 下 require is not defined） | 三 · preload 必须 CJS |
| main 进程 import workspace 包行为异常（外部化/旧产物） | 三 · externalizeDepsPlugin |
| 打包产物缺 pi SDK、Electron 版本漂移 | 三 · 打包两个坑 |
| Electron 二进制下载不动、npm 拦 postinstall | 三 · Node/npm 环境 |
| 新增 UI 文案只显示一种语言 | 四 · i18n 双字典 |
| 凭证泄漏风险、密钥误提交 | 五 · 绝不打印/提交 API key |

## 一、事故复盘（含可复用诊断手法）

### 0.4.6 全 app 冻结事故（2026-08-23）

glm-5.3 流式输出病态空白 thinking（纯 `\n    ` 洪流永不终止），pi SDK 每条 `message_update` delta 都携带全量累积快照（`partial`+`message` 两份）→ trace 落盘平方放大，**3 分钟写 12.7GB**；巨型事件再经 IPC 无上限转发 renderer → 堆爆 unresponsive。

修复三层全在 `pi-backend.ts` 的 `emitEvent` 单点：

1. `session/event-slim.ts` 剥快照（下游只吃 delta 白名单，终态靠 `message_start/end` 全量）
2. `session/stream-guard.ts` 熔断（连续空白 >8KB / 单消息 >2MB → abort+丢弃后续）
3. `session/trace.ts` 加固（巨事件截断标记、join 失败丢批不重试、flush 后按字节轮转、缓冲兑底）

**教训**：任何转发模型流式事件的中间层，都必须先瘦身再分发。诊断现场在正式版 `~/Library/Application Support/@percho/desktop/logs/` + `~/.pi/agent/sessions/*/traces/`。

### 0.5.0 流式期间反复白屏（2026-08-24，React #185）

`StreamingMarquee.tsx` 的无依赖 `useLayoutEffect(() => measure())` + ResizeObserver 双测量通道自成反馈环（measure→setMetrics→重渲染→再 measure，仅靠测量值相等守卫刹车），文本增长跨过溢出 class 翻转边界时 RO 回调与 effect 交错 → 守卫失效 → 无限更新 #185 → 整树卸载白屏。概率性触发，0.4.6 引入、当天 4 次。

修复：effect 加 `[text]` 依赖；防御：`AppErrorBoundary` 接线进 `main.tsx`（渲染期异常落到可恢复错误页而非白屏）。

**注意 #185 有两个不同成因**：本条是 effect 自激，zustand selector 不稳定是另一条（见下）。

**诊断手法可复用**：正式版症状在 `logs/main-*.log` 搜 `error #185`；dev 复现 = 把 trace 事件序列直接注入 renderer（`useTranscriptStore.getState().applyEvent`，详见 `scripts/repro-full.mjs` + `docs/INDEX.md`），比猜快得多。

## 二、pi SDK 集成

### 权限注入点：`session.bindExtensions({ uiContext, mode: "tui" })`（不是 `createAgentSession` 选项）

`pi-backend.ts` 的 `makeUiContext` 已有全量 no-op 实现（约 25 个成员）——只改 `confirm`，别重写。

### `Model`/`ThinkingLevel` 类型来自 `@earendil-works/pi-ai`（coding-agent 不 re-export）

`Model` 有 `name` 无 `label`；`model.provider` 是字符串。

### 无凭证时 `getAvailable()` 返回 `[]` —— 不能当可靠的模型列表

`runtime.getModel(provider, id)` 始终可用。

### `runtime.refresh()` 不传参时 `allowNetwork` 缺省为 true（除非 `PI_OFFLINE`）

会向 pi.dev 拉全部 provider 的远程模型目录，且 `fetchWithRetry` 无内置超时，网络不可达时一直挂（设置页曾因此永久 Loading）。`SettingsService.listProviders` 默认显式 `allowNetwork:false` 走本地，仅用户点刷新才 `forceNetwork`（`force:true` + 15s 超时兜底）。

### `createAgentSession({ tools: [...] })` 传数组 = 允许清单

数组外的工具（含扩展 `registerTool` 注册的）会被 `isAllowedTool` 整个过滤掉（sdk.js `_refreshToolRegistry`）——扩展工具要生效必须不传 tools（undefined，桌面正式路径）或把工具名列进数组；冒烟/测试脚本极易踩（ACP 冒烟 V3 曾因此假阴性：模型明说「工具列表为 none」）。

## 三、构建 · 打包 · 环境

### preload 必须是 CJS

sandbox 下渲染进程不加载 electron-vite 默认的 ESM 产物。config 强制 `format: "cjs", entryFileNames: "index.cjs"`；`main/window.ts` 加载 `../preload/index.cjs`。

### `externalizeDepsPlugin` 会把 workspace 依赖也外部化

main config 用 `exclude: ["@percho/backend", "@percho/shared"]` 并 alias 到源码；pi SDK 保持 external。

### Node >= 22.19。npm 11 默认阻止 Electron postinstall（需 `npm approve-scripts electron`）

二进制下载走 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

### 打包两个坑

pi SDK 必须声明进 `packages/desktop/package.json` dependencies（electron-builder 只从 desktop 依赖树收集）；electron 必须钉精确版本。发版/CI 细节全在 `.local/docs/release.md`（本地文档，不入库）。

## 四、Renderer / React

### Zustand selector 必须返回稳定引用（模块级 `EMPTY_ENTRY`）

内联 `?? []` 新数组会触发 React error #185 无限渲染（与 0.5.0 事故的 effect 自激是两个不同成因，症状相同）。

### UI 文案走 `useT()` + `zh`/`en` 字典（`renderer/src/i18n/`）

新增字符串两个都要加。

## 五、工程纪律

### 绝不打印/提交 API key

`models.json` 用环境变量引用（`$AI_OPS_API_KEY`），key 由用户自持。

### 已开源：github.com/Jaxton07/percho

git remote 走 SSH（本机直连 github.com:443 不通）。`main` 有分支保护（PR + CI `check` 必过 + squash merge），Release 由 tag 触发（`.github/workflows/release.yml`）。
