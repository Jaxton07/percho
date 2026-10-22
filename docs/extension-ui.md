# pi 扩展在 Percho 中的 UI 能力

本页描述**现行主会话能力**，不是待实施方案。适用于扩展兼容问题和 UI 桥接改动；SDK 行为基线为 1.4.0。

## 支持与降级

主会话经 `PiBackend.bindSessionExtensions` 注入 `ExtensionUIContext`，绑定 `mode:"rpc"` 并接入 onError。它表示非 TUI 宿主，不表示 Percho 使用 stdio RPC，也不保证终端组件可渲染。

| 能力 | 实际行为 |
|---|---|
| `select` / `input` / `editor` / `confirm` | 桥接 GUI 交互停靠槽；用户取消返回 undefined，confirm 返回 false |
| 对话框 timeout / AbortSignal | SDK 签名支持 opts 的 select/input/confirm 由 backend 宿主处理；editor 当前签名无 opts |
| `notify` | GUI Toast，限流和同源同文合并；不是系统通知 |
| `setEditorText` / `pasteToEditor` | 更新对应会话草稿，并提示来源；paste 没有独立粘贴语义 |
| `getEditorText` | 返回空串；没有跨进程同步读取 Composer 草稿的能力 |
| `theme` | 真实 SDK Theme 实例，供扩展调用格式化方法；不等于 GUI 当前主题 |
| `setTheme` | 明确返回失败，GUI 主题由宿主管理 |
| `custom()` | 返回 undefined，不渲染 ANSI/TUI Component |
| `setStatus/setWidget/setFooter/setHeader/setTitle` 等终端展示 | no-op |
| 工作指示器、工具展开态、补全/编辑器组件替换、原始终端输入 | 未桥接 GUI；具体返回值以 `makeUiContext` 为准 |

子代理或没有注入对应回调的上下文不具备同样的交互能力；`makeUiContext()` 的缺省行为是诚实取消/无操作，不默认选第一项，不伪造用户输入。

## 链路与所有权

- backend `session/ui-context.ts`：唯一的 SDK UI 适配对象，新增 SDK 成员在此处理。
- backend `session/extension-dialog-host.ts`：每会话对话框队列、请求 ID、超时/信号/关闭结算。
- shared `extension-dialog.ts` 与 IPC 契约：请求、应答、撤卡。
- renderer `components/session/DockSlot.tsx` / `InteractionDock.tsx`：权限审批与扩展交互的停靠槽展示；`ApprovalDock.tsx` 仍处理工具权限。
- renderer `stores/toasts.ts`：notify；`stores/drafts.ts`：编辑器预填。

**超时和取消的裁决在 backend，不依赖 renderer 倒计时。** 会话关闭必须结算所有等待请求；通用 confirm 不走 PermissionGate，不能把扩展提问与高危工具授权混成一种语义。

notify/预填的来源通过 stack 启发式归因，失败时不显示来源，不把猜测当精确扩展身份。错误回调进入日志/trace，不静默吞掉扩展异常。

## 未覆盖的内容

- `appendEntry` 的自定义持久化条目不自动显示为 GUI 消息。
- `sendMessage` 的 custom 消息尚无通用 GUI 实时/历史渲染投影；进入模型上下文不等于用户可见。
- `registerMarkdownTransformer` 未接入 GUI Markdown 渲染链路。
- 工具 `renderCall/renderResult/renderShell` 等 TUI renderer 不可直接移植；GUI 使用结构化结果和自己的组件。

只有真实需求出现时再设计这些能力，不把旧研究中的候选方案当已承诺功能。

## 验证

先读并运行相关单测；端到端冒烟入口为 `scripts/smoke-extension-dialogs.mts`。改桥接时至少覆盖：正常回答、主动取消、timeout/signal、关闭会话、后台会话归属、权限审批不被绕过。

核对 SDK 契约时查看已安装包的 `dist/core/extensions/types.d.ts`、`runner.js` 和官方 RPC 模式实现；不要用固定源码行号作为长期依据。
