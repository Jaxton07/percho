# pi 扩展 UI 交互调研与 Percho GUI 适配方案（issue #45）

> 日期：2026-09-09（当前版本 v0.5.6，SDK 钉 0.84.3）
> 调研范围：pi 官方 docs（`resources/pi-package/docs/extensions.md`、`rpc.md`）、SDK 实际类型与三种模式实现（`node_modules/@earendil-works/pi-coding-agent/dist/`）、Percho 现状代码、已装热门扩展的真实用法。
> 结论先行：**pi 扩展的所有 UI 交互收敛为一份 ~30 方法的 `ExtensionUIContext` 契约，进程内嵌入的宿主（Percho）只需实现这个对象即可全面接管**；其中真正的高频刚需是 4 个阻塞对话框 + 1 个通知，其余按「诚实降级」分层处理。

> **落地状态（2026-09-09，extension-dialogs 已实施）**：§3 的「现状盘点」已是历史。M1-M4 全部落地——select/input/editor/confirm 经 `ExtensionDialogHost` 桥到 GUI 停靠槽（`InteractionDock`），notify → 限流 Toast，setEditorText/pasteToEditor → 草稿预填；绑定统一 `mode:"rpc"` + `onError` 接 log/trace；setTheme 诚实返回失败。已知偏差：notify/预填的扩展来源是 stack 启发式归因（uiContext 是会话级共享单例，调用点无 extensionPath，官方 RPC 同样无），解析失败回退空串不显示副标题。实施决策与验收记录见 `.local/agent-work/channel/extension-dialogs/`（会不定期清理，决策已沉淀进代码注释）。

---

## 1. Issue #45 事实

- [percho#45](https://github.com/Jaxton07/percho/issues/45)：外部用户安装热门插件 `ask-user-question`（AI 拿不准时弹选择题问用户），在 Percho 中**屏幕上无任何弹窗，工具直接返回「用户拒绝回答」**——插件误以为用户真拒绝，AI 被误导。
- 根因定位准确：`packages/backend/src/session/ui-context.ts` 的 `makeUiContext` 是全量 no-op，`select`/`input`/`editor` 一律 `Promise.resolve(undefined)`（SDK 契约中 undefined = 用户取消），只有 `confirm` 桥接到了 PermissionGate → ApprovalDock。
- 用户的备选方案（「告诉插件该客户端暂不支持弹窗」）对应 SDK 的官方语义：`mode` 非 `"tui"`/`"rpc"` 时 `hasUI=false`，扩展可自行守卫降级。

## 2. pi 扩展 UI 交互类型全景

所有交互都经 `ctx.ui`（`ExtensionUIContext`，SDK `dist/core/extensions/types.d.ts:68`）。按交互语义分三类：

### A. 阻塞式对话框（返回 Promise；取消是合法返回值）

| 方法 | 签名 | 取消/超时返回 |
|---|---|---|
| `select` | `(title, options: string[], opts?)` | `undefined` |
| `confirm` | `(title, message, opts?)` | `false` |
| `input` | `(title, placeholder?, opts?)` | `undefined` |
| `editor` | `(title, prefill?)` | `undefined` |
| `custom` | `(factory, {overlay, overlayOptions, onHandle})` | 任意 `T`（TUI 键盘组件） |

`opts: ExtensionUIDialogOptions = { signal?: AbortSignal; timeout?: number }`（types.d.ts:36）。**timeout 由宿主实现倒计时并到点 resolve 默认值**；signal 用于外部中止（如 AI 取消提问）。

### B. 即发即忘（fire-and-forget，无返回值）

| 方法 | 语义 | GUI 对应物 |
|---|---|---|
| `notify(msg, "info"/"warning"/"error")` | 通知 | Toast |
| `setStatus(key, text \| undefined)` | footer keyed 状态条 | 会话状态区 |
| `setWidget(key, string[] \| 工厂, {placement})` | 输入框上/下方挂件 | Composer 上下方面板 |
| `setTitle(title)` | 终端窗口标题 | 窗口标题 |
| `setEditorText(text)` / `pasteToEditor(text)` | 设置/粘贴输入框内容 | Composer 草稿 |
| `getEditorText()` | 读输入框内容（**同步**） | 草稿 store 直读 |
| `setWorkingMessage/Visible/Indicator` | 流式期间工作指示器 | 工作动画（PreviewTicker/CenterOrb） |
| `setHiddenThinkingLabel(label)` | 隐藏 thinking 块的标签 | thinking 折叠文案 |
| `setToolsExpanded/getToolsExpanded` | 工具输出展开态 | 工具卡展开 |
| `setFooter/setHeader(工厂)` | 整体替换 footer/header | TUI 专属（组件工厂） |
| `setEditorComponent/getEditorComponent` | 替换编辑器（vim 模式等） | TUI 专属（组件工厂） |
| `addAutocompleteProvider(factory)` | 输入补全叠加层 | 纯文本契约，GUI 可接 |
| `onTerminalInput(handler)` | 原始终端按键流 | 无 GUI 对应 |
| `theme` / `getAllThemes` / `getTheme` / `setTheme` | 主题读取/切换 | 部分可映射 GUI 主题 |

### C. 数据旁路（不经 `ctx.ui`，但决定「扩展内容在 GUI 怎么显示」）

| API | 语义 | GUI 现状 |
|---|---|---|
| `pi.appendEntry(customType, data)` + `registerEntryRenderer` | 持久化条目，**不进 LLM 上下文**，渲染器返回 TUI Component | ❌ **黑洞**：既不是 message，不在 `getMessages()` 返回里，也不在事件流里——GUI 完全看不到 |
| `pi.sendMessage({customType, content, display, details})` + `registerMessageRenderer` | 自定义消息，**进 LLM 上下文**，display=true 时应显示 | ⚠️ 半黑洞：历史回放 `toSessionMessages` 忽略 `role:"custom"`；SDK 事件流会发 `message_start/end`（reducer 对 custom 消息基本无操作），GUI 无渲染器 |
| `pi.registerMarkdownTransformer(fn)` | 显示层纯文本变换（user/assistant/thinking，流式也跑） | ❌ 未接；可经 `runner.getMarkdownTransformers()` 拿到逐条 apply |
| 工具 `renderCall/renderResult/renderShell` | 工具卡 TUI 自定义渲染（返回 Component） | ❌ 结构性不可移植（终端渲染模型），GUI 只能忽略渲染器、用结构化 `details` 自绘 |

### 三种官方模式的 UI 语义（SDK 自带实现）

| 模式 | `ctx.mode` | `ctx.hasUI` | 实现路径 |
|---|---|---|---|
| TUI | `"tui"` | true | `interactive-mode.js:1909 createExtensionUIContext()`：对话框替换编辑器容器组件；`custom()` 支持 overlay |
| RPC | `"rpc"` | true | `rpc-mode.js:83`：**stdout 发 `extension_ui_request` JSON，stdin 收 `extension_ui_response`**；`custom()`→undefined、工厂类全 no-op |
| JSON/print | `"json"`/`"print"` | false | `runner.js:88 noOpUIContext`：select→undefined、confirm→false |
| **SDK 进程内嵌入（Percho）** | 宿主绑什么就是什么 | 由注入决定 | `session.bindExtensions({ uiContext, mode, ... })`（agent-session.d.ts:145）。不绑 = noOp + `mode:"print"` |

关键事实：**进程内嵌入没有独立的「扩展 UI 事件协议」，就是注入一个 JS 对象**。`ExtensionRunner.hasUI()` 的实现是 `this.uiContext !== noOpUIContext`（runner.js:275）——只要 Percho 注入了自己的 uiContext，扩展就看到 `hasUI=true`。

## 3. Percho 现状盘点（截至 v0.5.6）

- `makeUiContext(gate)`（`backend/src/session/ui-context.ts`）：全量 no-op，**只有 `confirm` 桥接**到 PermissionGate → IPC `pi:permission-request` → renderer `ApprovalDock`（这条链路是目前唯一完成的扩展 UI 适配，可直接作为新链路的模板）。
- `bindExtensions` 三处调用（`pi-backend.ts:374` createSession、`:425` openSession、`tools/subagent/runner.ts:219`）均绑 `mode: "tui"`，且**仅在 `permissionGates !== false` 时绑定**（逃生舱关闭权限门 → 完全不绑 → 扩展退化为 print 语义 hasUI=false）。
- **theme 必须是真实 `Theme` 类实例**（issue #28 事故：假对象让 pi-mcp-adapter `theme.fg()` 抛错、MCP 全挂），已有 `ui-context.test.ts` 回归测试。

### 现存缺口（按严重度）

1. **`select`/`input`/`editor` 静默取消**（issue #45 本身）：扩展收到的语义是「用户取消了」，AI 被误导「用户拒绝回答」。
2. **`opts`（signal/timeout）被整体丢弃**：`makeUiContext` 的 confirm 签名只透传 `(title, message)`。超时对话框（timed-confirm 类）在 GUI 下永不自动消失；AI 中止时对话框无法程序化关闭。
3. **`mode: "tui"` 名不副实**：扩展做 `ctx.mode === "tui"` 守卫后会去调 `custom()`/`setFooter()` 等 TUI 专属 API，拿到 undefined/no-op。pi-mcp-adapter 实测即如此：它检测到非真 TUI 后用 notify 提示「交互面板只在终端可用」——行为正确，但说明 mode 虚标会诱导扩展走死路。
4. **`setTheme` 假成功**：恒返回 `{ success: true }`（SDK noOp 版返回 `{success:false, error:"UI not available"}`），扩展据返回值分支会误判。
5. **`notify` 丢弃**：pi-mcp-adapter 大量使用（连接失败、OAuth 引导、状态汇报），当前全部静默——用户不知道 MCP 服务器为什么没连上。
6. **扩展错误不可见**：`bindExtensions` 未绑 `onError`（RPC 模式会输出 `extension_error` 事件），扩展抛错对 GUI 完全静默。
7. **appendEntry / custom 消息 / markdownTransformer 未投影**（见 §2.C），扩展产出的富内容在 GUI 是黑洞。

## 4. 已装扩展真实用法取证（本机 `~/.pi/agent/npm/node_modules/pi-mcp-adapter`）

热门桥接扩展 pi-mcp-adapter 是最大公约数用户：

- `notify` ×20+（连接状态/错误/OAuth 引导）——当前 Percho 全丢；
- `setStatus("mcp", ...)` 状态条 + `theme.fg("accent", ...)`（issue #28 的崩点）；
- `confirm` + `input`（OAuth 粘贴流程）；
- `custom()` ×3（`/mcp` 设置面板、auth 面板、直连工具面板），且**已正确降级**：检测非 TUI 后 notify 提示「请编辑 .mcp.json 或用 /mcp status」——证明「custom 不做、文档化降级」是生态已接受的策略。

## 5. 适配方案（分层 + 分期）

设计原则：

- **D8（已有）：不伪造用户输入**——不默认选第一项、不返回空串；取消就返回契约的取消值。
- **诚实降级**：做不到的能力返回「明确的失败/不支持」（`{success:false, error}` / undefined + notify 提示），不返回假成功。
- **对齐官方 RPC 语义**：pi 官方已经替我们定义过「非 TUI 宿主」每个方法的降级行为（rpc.md「Extension UI Protocol」+ rpc-mode.js 实现），Percho 直接把它当规范抄——能做到的按 RPC 协议做，做不到的按 RPC 降级。
- **新链路复制 ApprovalDock 模式**（backend 队列 → 共享类型 → IPC 事件 → renderer store → 停靠式 UI → IPC 应答），不引入第二种机制。

### P0 — 对话框四件套（issue #45 直接需求）

`select` / `input` / `editor` 桥接 + `confirm` 补 `opts`（signal/timeout）：

- **backend**：新建 `ExtensionDialogHost`（与 PermissionGate 平行的会话级队列）：请求 `{id, sessionId, kind, title, options?/placeholder?/prefill?, timeoutMs?}`，经 IPC 推 renderer；应答经 IPC 回传 `{value}` / `{confirmed}` / `{cancelled:true}`。内置权限扩展继续走 PermissionGate 直通道（要 meta/allowDir/allowAlways），其余扩展的 confirm 走通用对话框（**不会双弹**）。
- **timeout 宿主实现**：对齐 TUI/RPC 语义，timeout 到点自动 resolve 取消值（select/input→undefined、confirm→false）；renderer 显示倒计时。
- **signal**：AbortSignal 触发 → 撤卡 + resolve 取消值（等价 RPC 的 agent 侧 auto-resolve）。
- **renderer**：与 ApprovalDock 同槽位的「交互停靠槽」组件族（select 列表 / input 单行 / editor 多行 / confirm 两键，Esc=取消）；跨会话请求按 sessionId 归属路由，后台 tab 复用现有 attention 呼吸点提醒。
- **UI 定稿决策（2026-09-09 review，设计稿见 .local/design/ux/extension-dialogs/）**：容器走 error-system 无边框语言（rounded-xl · surface · shadow-soft）；扩展提问 = accent 问号 glyph（中性），权限审批 = amber 三角 glyph（警示）；操作全部幽灵文字按钮（主操作 ink 加重）；**权限审批卡本期顺带迁移到同一语言**（实心 primary 退场），行为/通道/记忆逻辑不变；`setEditorText` 预填带一次性来源提示（首次编辑即消失）；select 超长列表过滤框首版不加。
- **验收**（对应 issue）：`ask-user-question` 端到端可用——AI 提问 → GUI 弹选项 → 用户选择/取消如实返回；主动取消才返回 undefined。

### P1 — 低成本即发即忘 + 可见性修复

| 项 | 做法 |
|---|---|
| `notify` | 映射 renderer Toast（info/warning/error 三级已有样式与 i18n 模式）；**限流**：栈上限 3、同扩展同文本 8s 合并、溢出折叠一行注脚；副标题标注扩展名 |
| `onError` | bindExtensions 绑 `onError` → 结构化 log + trace_custom 行（扩展崩溃不再静默） |
| `setTheme` 诚实化 | 返回 `{success:false, error:"Theme switching is managed by Percho"}`（主题由宿主管理，不开放插件切换） |
| `setTitle` | **不接**（mac 窗口 hiddenInset 无可见标题栏，无落点） |
| `setStatus` / `setWidget` | **本期不接**（TUI footer 文化，GUI 无天然等价区；待真实需求驱动再设计） |
| `setEditorText` / `getEditorText` | 写/读 Composer 草稿 store（`stores/drafts.ts`；getEditorText 进程内同步实现，比 RPC 模式更强）；写入时浮现一次性来源提示，首次编辑即消失 |
| `pasteToEditor` | 降级 = setEditorText（对齐 RPC；无粘贴折叠语义） |

### P2 — 显示层投影（让扩展内容在 GUI 可见）

- `registerMarkdownTransformer`：经 `runner.getMarkdownTransformers()` 逐条 apply 到 Markdown 渲染输入（同步纯函数，流式也安全；需与 markstream 的 pacing 兼容评估）。
- `pi.sendMessage` custom 消息：backend `toSessionMessages` 增加 `role:"custom"` 投影 + reducer/历史回放渲染（内容字符串 + details 结构化展示）；`registerMessageRenderer` 的 TUI 渲染器忽略。
- `appendEntry` 条目：从 `sessionManager.getEntries()` 提取 custom entries 做只读展示（独立于消息流的时间线卡片）；渲染器忽略。
- `setWorkingMessage/Visible/Indicator`：驱动工作状态动画（frames 需剥 ANSI 或仅取文案，用自家动画）。

### P3 — 可做可不做的增强

`addAutocompleteProvider`（纯文本契约，可叠到 Composer 的 @ 补全体系）、`registerShortcut` 枚举接 GUI 快捷键（`runner.getShortcuts()`）、`getToolsExpanded/setToolsExpanded` 映射工具卡展开态。

### 明确不做（文档化降级）

| 能力 | 原因 |
|---|---|
| `custom()`（含 overlay） | Component 契约 = `render(width): string[]` ANSI 终端行 + 键盘流 + Focusable/IME，本质是终端渲染模型，移植成本/收益倒挂；生态已接受降级（pi-mcp-adapter 行为） |
| `setFooter/setHeader/setEditorComponent` | 组件工厂，同上 |
| `onTerminalInput` | 原始按键流，无 GUI 对应 |

### `mode` 语义决策（需拍板）

当前绑 `mode:"tui"` 是虚标。两个选项：

1. **改绑 `mode:"rpc"`**（推荐）：官方「半可用」语义——hasUI=true、对话框可用、TUI 专属明确降级；扩展的 `ctx.mode === "tui"` 守卫会正确绕开死路（pi-mcp-adapter 即受益者）。
2. 保持 `"tui"`：对话框也能用，但持续诱导扩展调 `custom()` 拿 undefined。

注意点：`hasUI` 由「是否注入了自定义 uiContext」决定（runner.js:275），与 mode 字符串无关；且当前 `permissionGates === false` 逃生舱会完全不绑（扩展退到 print 语义）——若 P0 落地，建议绑定条件与权限门解耦（UI 桥接 ≠ 权限门）。

## 6. 落地路径建议

1. **P0 单独一个 PR**（issue #45 闭环）：ExtensionDialogHost + IPC 三件套（请求/应答/撤卡）+ 停靠式对话框 UI + `opts` 贯通 + mode 改 `"rpc"` + 绑定条件解耦 + 权限审批卡迁移无边框语言。冒烟：`ask-user-question` 或官方 `examples/extensions/question.ts` 实测。
2. **P1 一个 PR**：notify→Toast（含限流）、onError、setTheme 诚实化、setEditorText 系。
3. **P2 本期冻结**（用户已拍板 2026-09-09）：markdownTransformer / custom 消息 / appendEntry / 工作指示器均不做，待真实需求驱动重启评估。
4. 每期完成后更新本文件「Percho 现状」一节，并把新链路模式记入 `docs/INDEX.md`。

---

### 附：关键源码坐标（核对用）

| 事实 | 位置 |
|---|---|
| ExtensionUIContext 契约 | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:36,68` |
| bindExtensions 入口 | `dist/core/agent-session.d.ts:145,525`；实现 `dist/core/agent-session.js:1831` |
| noOp 默认实现 / hasUI 判定 | `dist/core/extensions/runner.js:88,268,275` |
| TUI 版 UI 实现（含 timeout/signal 处理） | `dist/modes/interactive/interactive-mode.js:1909` 起 |
| RPC 版 UI 实现（降级语义范本） | `dist/modes/rpc/rpc-mode.js:83` 起 |
| RPC UI 协议文档 | `resources/pi-package/docs/rpc.md`「Extension UI Protocol」 |
| Percho 现有桥接 | `packages/backend/src/session/ui-context.ts`；绑定 `pi-backend.ts:374,425`、`tools/subagent/runner.ts:219` |
| PermissionGate 模板链路 | `backend/src/permissions/gate.ts` → `main/ipc/index.ts:46` → `renderer/stores/transcript.ts` → `components/session/ApprovalDock.tsx` |
