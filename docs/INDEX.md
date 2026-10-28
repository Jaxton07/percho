# 开发导航

本页只帮助定位，不是必读的源码目录。按任务选择入口和专题，不需要遍历所有文档。

## 专题

| 需要了解 | 文档 |
|---|---|
| 包边界、IPC、会话数据与状态所有权 | [架构](architecture.md) |
| 界面风格、字号、浮层、共享组件 | [UI 规范](ui.md) |
| CDP、截图、交互验收、测试实例管理 | [UI 调试](ui-debugging.md) |
| 用户级目录隔离、升级迁移、失败恢复 | [用户数据](local-agent-storage.md) |
| SDK 行为、升级、资源释放、上下文 | [SDK 集成](sdk.md) |
| pi 扩展在 GUI 中实际支持哪些交互 | [扩展 UI](extension-ui.md) |
| SSH 远端使用、连接与恢复边界 | [远端开发](ssh-remote.md) |
| 构建、打包、验包 | [构建发布](build-release.md) |
| Windows 更新取证、恢复 | [Windows 更新](WINDOWS-UPDATES.md) |
| 按症状选择排查方向 | [排障入口](PITFALLS.md) |

## 代码入口

以下路径相对各包的 `src/`；renderer 路径相对 `packages/desktop/src/renderer/src/`。先从入口跟调用链，不在此维护完整导出清单。

| 想改什么 | 从哪里开始 |
|---|---|
| 跨进程 API、事件和共享类型 | shared `ipc-channels.ts`、`ipc.ts`；desktop `main/ipc/`、`preload/index.ts` |
| 会话创建、打开、关闭、分叉、撤回、重试 | backend `pi-backend.ts` → `session/`；renderer `stores/sessions.ts` |
| 导航、并发装载、历史就绪 | renderer `stores/session-navigation.ts`、`session-loading.ts`、`session-history.ts` |
| 会话目录、项目、左栏分组 | renderer `stores/projects.ts`、`lib/sidebar-groups.ts`、`components/sidebar/` |
| 顶栏胶囊、左侧轨道、工作区恢复 | renderer `stores/session-workspace*.ts`、`components/session/`；移出动作 `lib/workspace-actions.ts` |
| 会话自动卸载、频道驻留 | renderer `lib/session-gc*.ts`、`lib/use-session-gc.ts`；backend `channel-subscriptions.ts` |
| 消息事件、历史回放、轮次派生 | shared `transcript/`；backend `session/messages.ts`；renderer `stores/transcript.ts` |
| 消息气泡、Markdown、Mermaid、工具卡 | renderer `components/chat/`；流式合流 `stores/event-conflator.ts` |
| 输入、发送、停止、排队、斜杠与 @ 补全 | renderer `components/composer/`、`stores/drafts.ts`；backend `slash-commands.ts` |
| 图片附件与历史图资源 | renderer `lib/image-attachment.ts`、`lib/image-fit.ts`、`components/chat/history-image/`、`ImagePreview.tsx` |
| 错误卡、分类、手动重试 | shared `errors.ts`、`transcript/llm-errors.ts`；renderer `stores/session-retry.ts`、`components/chat/ErrorNote.tsx` |
| 轮次计时、文件变更、diff 侧栏 | shared `transcript/turn-*`；renderer `components/chat/TurnDiffChip.tsx`、`components/diff/` |
| 工具权限、项目边界、信任 | backend `permissions/`、`project/trust*.ts`、`project/workspace-store.ts` |
| provider、登录、模型可见性、子代理偏好 | backend `settings/`；shared `model-visibility.ts`；renderer `stores/settings.ts`、`components/settings/providers/` |
| MCP 配置、状态与重连 | backend `mcp/`、`tools/mcp-inventory.ts`；renderer `stores/mcp.ts`、`components/settings/mcp/` |
| 内置工具、子代理、todo、频道协作 | backend `tools/`；子代理只读检视与返回关系在 renderer `stores/subagent-return.ts` |
| 上下文蒸发、压缩护栏 | backend `tools/context-evaporation/`、`tools/compaction-guard/` |
| 扩展选择题、输入、确认、通知 | backend `session/ui-context.ts`、`extension-dialog-host.ts`；renderer `components/session/InteractionDock.tsx` |
| 设置页及按域加载 | renderer `components/settings/`、`stores/settings.ts`；新增分类入口 `SettingsDialog.tsx` |
| UI 插件运行时与发布契约 | renderer `plugins/`；desktop `main/ui-plugins/`、`resources/ui-plugins/SPEC.md` |
| 主题、字号、基础样式、文案 | renderer `styles/`、`stores/theme.ts`、`lib/typography.ts`、`i18n/`；字号档位在 shared `typography.ts` |
| 窗口、退出、尺寸恢复、开发数据隔离 | desktop `main/window.ts`、`window-bounds.ts`、`dev-agent-dir.ts` |
| 自动更新和诊断 | desktop `main/updater.ts`、`update-policy.ts`、`update-diagnostics.ts`、`build/update-diagnostics.nsh` |
| SSH 独立服务与环境路由 | backend `runtime/`；desktop `main/remote-connection.ts`、`environment-router.ts`；renderer `environment-api.ts`、`components/remote/` |
| 跨设备互联 | shared `lan.ts`；backend `lan/`；desktop `main/lan.ts`、`src/lan-web/` |
| 日志、事件 trace 与崩溃 | backend `log.ts`、`session/trace*.ts`；desktop `main/renderer-watchdog.ts` |

## 验证工具

自动检查用根目录 `typecheck` / `test` / `lint`。专项脚本都在 `scripts/`，**具体参数、安全前提和断言以脚本文件头为准**，不在索引复制。

- SDK 与后端：`smoke-sdk.mts`、`smoke-backend.mts`、`smoke-error-events.mts`、`smoke-subagent.mts`、`smoke-extension-dialogs.mts`。
- 状态重放：`replay-trace.mts`、`repro-full.mjs`；上下文调参：`replay-evaporation.mts`、`replay-compaction-bound.mts`。
- UI/CDP：`cdp-eval.mjs`、`cdp-shot.mjs`；按功能查找 `check-*`、`verify-*`、`shoot-*`。

## 临时资料

`.local/` 不入库：`docs/release.md` 为本机发版操作，`design/` 为设计稿，`agent-work/` 为临时 spec/plan/channel。不要在这里登记各阶段产物；接手频道任务必须先加载 `channel-pickup` skill，再读 HANDOFF。
