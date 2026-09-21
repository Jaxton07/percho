# Percho 项目索引

> 改动代码前读这份索引，定位「该改哪块」；改动完成后检查是否过时（文件增删、导出变化、职责变化都要同步）。
> 排查疑难问题优先看 `docs/PITFALLS.md`（症状索引 + 事故复盘）；打包发版流程见 AGENTS.md 与 `.local/docs/release.md`。
> 本文件只做**导航**：职责一句话 + 指到源码；实现细节以代码为准，坑记 PITFALLS，不在此堆积。

## 硬约束（改代码前必知）

- renderer 绝不 import pi 包，只经 `window.pi`（preload）通信
- `packages/backend/src/pi-backend.ts` 是唯一 import pi SDK 的地方（钉 0.84.3）
- 新增 IPC：通道进 `shared/src/ipc-channels.ts` 对应域子表（key=方法名，args/ret 类型随表）→ 域文件 `registerInvokeHandlers` 一行 handler → preload/main 自动接线（事件通道仍在 EVENT_CHANNELS 手写段）；事件转发在 `main/ipc/index.ts`
- preload 必须保持 CJS（sandbox 限制，见 PITFALLS）
- 新增 UI 文案：`i18n/zh.ts` + `en.ts` 双字典都要加
- zustand selector 必须返回稳定引用（模块级空对象/数组；#185 无限渲染，见 PITFALLS）
- 新增 renderer hook/store 要暴露给插件 = 源模块 + `plugins/host-api.ts` + `plugins/env.d.ts`（PerchoUiApi）+ `main/ui-plugins/build.ts` SHIM + `resources/percho-ui.d.ts`（必要时 SPEC.md 导出清单）五处同步
- JSON 持久化一律走 backend `JsonStore`（原子写 + 损坏语义），不自写 fs

## 总览

npm workspaces monorepo，3 个包：

```
packages/
├── shared/     IPC 契约层（纯类型 + 通道常量，三方共享）
├── backend/    纯 Node；pi SDK 适配层
└── desktop/    Electron 应用（main / preload / renderer）
```

| 脚本 | 用途 |
|---|---|
| `scripts/smoke-backend.mts` | 真实 SDK 冒烟（需 `AI_OPS_API_KEY`） |
| `scripts/smoke-error-events.mts` | 报错系统冒烟：本地 HTTP 伪造 provider（401/429）驱动 PiBackend，零凭证离线 |
| `scripts/smoke-subagent.mts` | subagent 冒烟 |
| `scripts/smoke-evaporation-ui.mjs` | 蒸发设置二态 CDP 冒烟（dev 实例带 `--remote-debugging-port=9224` 运行后执行） |
| `scripts/smoke-channel-watch.mts` | channel-watch 机制冒烟 V1–V8：V1–V3 需真实模型；**V4–V8 零凭证离线**（V6 扩展钩子/todo 工具、V7 订阅快照上报 + GC intent 守卫走真 PiBackend、V8 关重开后离线变化补投一次＋游标落盘） |
| `scripts/replay-trace.mts` | 事件 trace 离线重放（`--last` 自动找最新；排查 UI 状态问题首选） |
| `scripts/replay-evaporation.mts` | 上下文蒸发离线 replay 调参（误杀率/体积曲线；`--core` 与线上实现同构对比；默认数据指 `.local/replay-data/sessions` 副本，指向正式 `~/.pi/agent` 会直接 abort） |
| `scripts/verify-vertex-auth.mts` | google-vertex 认证链路隔离验证（临时 `PI_CODING_AGENT_DIR`，不碰正式配置）：api_key 路径会 401「API keys are not supported by this API」→ 只有 ADC/服务账号可用 |
| `scripts/verify-vertex-login.mts` | google-vertex 完整登录桥验证：PiBackend.login 交互（select 剔除 api-key）→ ADC credential 落盘 auth.json → configured |
| `scripts/repro-full.mjs` | 把 trace 事件序列直接注入 renderer 复现（#185/白屏类问题，手法见 PITFALLS 0.5.0） |
| `scripts/shoot-sidebar.mjs` | UI 动画 CDP 逐帧截图模板（左栏 240↔0 开合演示，换场景照抄三步：触发状态 → **按 CSS 参数复现每一步**（关过渡写 inline style；别 pause 动画，见 PITFALLS）→ captureScreenshot） |
| `scripts/cdp-eval.mjs` / `cdp-shot.mjs` / `shoot-demo-gif.mjs` | CDP 页面单次求值 / 截图 / demo gif |

依赖补丁：`patches/` + patch-package（root devDep + postinstall）。目前一处 `thinking-orbs+0.3.1.patch`（移除 IntersectionObserver+visibilitychange 门控，Win11 恢复事件丢失会冻住 rAF）。改法：手改 `node_modules/thinking-orbs/dist/index.{es.js,cjs}` 两份 → `npx patch-package thinking-orbs`；升级该包前重评补丁是否仍需要。

数据与凭证：用户数据在 `~/.pi/agent/`（sessions/*.jsonl、auth.json、models.json、trust.json、workspaces.json），与 CLI pi 共享；**dev/预览态自动隔离**到 `~/.pi/agent-dev/`（`main/dev-agent-dir.ts`，含五配置种子拷贝）。会话事件 trace 在 `sessions/<dir>/traces/trace-<sessionId>.jsonl`。应用自身数据在 Electron `userData/`：ui-state.json、backgrounds/（v10 起没有 tabs.json）（renderer 经 `pi-bg://background/<文件名>` 协议加载，main 注册）。

## packages/shared — IPC 契约层

**何时改这里**：新增/修改 IPC 通道或跨进程类型（然后按硬约束四处同步）。

| 文件 | 关键导出 | 职责 |
|---|---|---|
| `src/ipc-channels.ts` | `CHANNEL_TABLE`、`ch`、`IpcChannels`、`InvokeApi`/`InvokeHandlers` | **IPC invoke 通道单一事实源**：key（=PiApi 方法名）→ 通道字符串 + args/ret 类型；按域子表（SESSION/SETTINGS/PACKAGES/APP/LAN/EXTENSION_DIALOG/UI_PLUGINS）；EVENT_CHANNELS 段 = main→renderer 单向事件（PascalCase 手写） |
| `src/ipc.ts` | `PiApi` | `window.pi` 完整类型：invoke 成员由 `InvokeApi<CHANNEL_TABLE>` 推导 + 订阅 on* ×11 与 `platform` 手写 |
| `src/session.ts` | `SessionMeta`、`SessionStats`、`AvailableModel`（可选 `thinkingLevels`/`imageInput`，缺省 fail-open）、`SessionEvent`、`SessionMessage`、`UiState`、`PermissionRequest`、`PermissionMode`（default/fullAccess）、`TrustRequest`、`LoadedResources` 等 | 会话/事件跨进程类型。`SessionEvent` = pi `AgentSessionEvent` ∪ Percho 自有 UI 事件（`subagent_mutex`/`stream_guard_tripped`，不进 trace）；`SessionMessage` union：user/assistant（均带 `entryId` 供 fork/撤回；user 专属 `skill`/`sourceText`）+ `role:"image"`（show_image 回放）+ `role:"subagent"` |
| `src/transcript/` | `reduceEvent`、`messagesToUIMessages`、`buildChatRows`、`deriveTurnChanges`、`deriveTurnTimings` | **UI 消息状态机（桌面与 lan-web 共用同一份）**：`types`（UIMessage/StreamingState 等）、`helpers`（事件载荷解析）、`reducer`（pi 事件 → UI 状态）、`mapping`（历史回放）、`parse-patch`（unified diff 结构化解析）、`turn-files`（按轮聚合文件变更）、`turn-timings`（按轮计时派生 + runEndedAt 定格）、`chat-rows`（行序列分组 + 轮末行定位规则；入参 `ChatRowsInput` 四字段收窄）、`llm-errors`（LLM 错误轮判定 live/replay 共用）、`meta-summary`（工具语义分类统计） |
| `src/errors.ts` | `UiError`、`classifyLlmError`、`buildLlmUiError`、`buildStreamGuardUiError`、`DETAIL_MAX_LENGTH` | 统一报错信封：错误卡数据源（live reducer / 历史回放 mapping / Composer 内联 / LAN 共用）；`classifyLlmError` 按 401/429/context/网络模式分类，误判只影响标题措辞 |
| `src/ui-plugins.ts` | `UiPluginManifest`、`UiPluginInfo`、`UiPluginsConfig`、`KNOWN_UI_SLOTS`、`KNOWN_UI_REGIONS`、`UI_PLUGIN_ANCHORS` | UI 插件跨进程类型：manifest（slots/contributions/headless 三选一）/ 扫描合成信息 / 持久化配置 / 事件载荷；`KNOWN_*` 供 main 校验，与 renderer `plugins/slots.ts` 对齐（registry.test.ts 断言） |
| `src/lan.ts` | `LanObserverConfig`、`LanStatus`、`LanSessionBrief/View`、`LanSseFrame` | 局域网观察页跨进程/HTTP 投影契约 |
| `src/packages.ts` | `CatalogPackage*`、`NPM_NOT_FOUND_SENTINEL`、`isSubagentPackage` | pi.dev 社区包目录类型（设置页扩展面板用；`isSubagentPackage` 启发式仅供安装警示，非安全边界） |
| `src/settings.ts` | `ProviderInfo`、`CustomProviderInput`、`KNOWN_APIS`、`LoginAuthPrompt/LoginEventPayload`、`ModelPrefs`、`SubagentInfo` 等 | provider 设置类型（含订阅登录 OAuth 镜像）+ 子代理偏好（模型/思考深度/执行器开关；thinking 值域见 `src/thinking.ts`） |
| `src/subagent.ts` | `SubagentRunData`、`extractSubagentRuns`、`isSubagentToolName` | 子代理结果提取（结构检测不依赖工具名；single/parallel/management 三形态），backend 历史映射与 renderer 共用 |
| `src/skill-invocation.ts` | `parseExpandedSkillInvocation`、`formatSkillCommand` | 成功展开的 skill 调用展示投影：严格匹配 SDK canonical producer 格式，提取安全 name/args；backend 命名/撤回与 renderer 实时映射共用 |
| `src/thinking.ts` | `THINKING_LEVELS`、`ThinkingLevel`、`isThinkingLevel` | 思考档位单一事实源（7 档 + 白名单校验）：backend 解析 agent frontmatter / model-prefs 脏值过滤与 renderer 下拉共用；**只判合法不收敛**（收敛交 SDK clamp） |
| `src/todo.ts` | `TodoItem`、`TODO_TOOL_NAME`、`extractTodos` | todo 工具契约（backend 注入与 renderer 面板共用） |
| `src/update.ts` | `UpdateState` | 自动更新事件载荷（`available.manual=true` = 当前构建无法自动安装，跳 release 页） |
| `src/marquee-motion.ts` | `tailOffsetForWidths` | 流式正文 tail-follow 位移纯函数（无 DOM，可单测） |

## packages/backend — pi SDK 适配层

纯 Node，不依赖 Electron。唯一 import pi SDK 的包，import 收敛在 `pi-backend.ts`。

```
src/
├── index.ts            barrel
├── pi-backend.ts       门面：会话生命周期 + 各域薄委托（desktop main 只 import 这里）
├── emitter.ts          泛型订阅/分发原语（9 套事件管线共用，per-handler try-catch 隔离）
├── json-store.ts       统一 JSON 持久化原语
├── slash-commands.ts   斜杠命令清单（纯函数）
├── log.ts              结构化日志
├── lan/                局域网观察：config / projector / server（+ audit / sanitize）
├── session/            registry / meta / single-flight / naming / messages / trace+traces / event-slim+stream-guard / rates / ui-context / extension-dialog-host
├── permissions/        index(barrel) / bash-chain / pattern / config / tmp-zone / gate / extension / audit
├── project/            trust / trust-loader / workspace-store / files
├── settings/           settings / model-prefs / login / quota
├── packages/           admin / catalog
└── tools/              show-image / todo / todo-reminder / webfetch / subagent / context-evaporation / channel-watch
```

| 文件 | 关键导出 | 职责 |
|---|---|---|
| `src/pi-backend.ts` | `PiBackend` | **门面**：create/open/close/delete/prompt（followUp 排队，preflight 回执见 `use-composer-send`）/abort/fork/recall/compact/stats/listModels（附 `thinkingLevels`/`imageInput`）/会话权限模式（`registry entry.modeRef` 内存态 + get/setSessionPermissionMode，随 buildExtensionFactories 闭包注入扩展）/事件与权限·信任分发（emitter.ts 统一原语，9 emitter）（respondPermission **先 gate.respond 放行再持久化**，持久化失败只 log 不挂会话）。**`openSession` 幂等**：`resolve()` 规范化路径 → `KeyedSingleFlight`（同文件并发只构造一次）+ **读 header 取 sessionId 命中 registry 即短路返回现有 meta**（在 `getModelRuntime`/资源加载/扩展构造之前，不重复 subscribe/trace）；`wireSession` 里 registry.add 冲突（并发/别名路径最后防线）会把刚构造的 unsubscribe/gate/dialogs/session 全 dispose 后重抛。`buildCustomTools(gate, preferBuiltin)` 注册 webfetch+show_image+todo+subagent（preferBuiltin 优先级：构造参数 > model-prefs 实时值 > true）；`buildExtensionFactories` 注册序 = context 钩子链序：权限门控 → 上下文蒸发 → channel-watch → todo-reminder（最后，注入不被折叠）；subagent 子会话 `noExtensions`。**频道订阅快照**（`channelSubscriptionIds`：`reportChannelSubscriptions` 由 channel-watch 扩展回调维护、`getChannelSubscriptionSessionIds` 供 renderer GC 查询，只返回仍在 registry 的 ID；dispose 兜底清理）+ **`closeSession(id, intent)`**：缺省/`user` = 用户意图（仅 streaming 守卫）；`gc`（renderer 自动卸载）额外拒绝有订阅的会话。`sessions-subagents/` 下会话记 readOnly，prompt/fork/recall/setModel 一律 throw |
| `src/json-store.ts` | `JsonStore`、`JsonStoreCorruptedError` | 统一 JSON 持久化：tmp+rename 原子写；read 损坏回退默认、update 损坏抛 CorruptedError 拒写；async 版 per-path 队列串行化、sync 变体热路径用；缓存/normalize 不进本层 |
| `src/slash-commands.ts` | `BUILTIN_SLASH_COMMANDS` | 内置静态表（compact/name/export/settings）+ 模板/skill/扩展命令映射（纯函数） |
| `src/log.ts` | `createLogger`、`initLogging` | 结构化日志：按天落盘 `main-<本地日期>.log`（`PI_LOG_LEVEL`/`PI_LOG_DIR`） |
| `src/emitter.ts` | `Emitter<T>` | 泛型订阅/分发：subscribe 返回退订、emit per-handler try-catch、clear/size（canAsk 探测）；PiBackend 9 套事件管线共用 |
| `src/session/registry.ts` | `SessionRegistry`、`RegisteredSession` | sessionId → AgentSession 单条记录（session/unsubscribe/cwd/readOnly + **gate/dialogs/modeRef 会话级状态随 entry 生命周期**）；`add` 同 entry 幂等、**不同 entry 同 sessionId 抛错（不静默覆盖，防旧实例订阅/gate/dialogs 泄漏）**；delete/disposeAll 做 entry 级清理；`toMeta` 时间字段走 `session/meta.ts` |
| `src/session/meta.ts` | `deriveSessionTimes`、`fallbackSessionTimes` | **会话时间字段唯一口径**（与 SDK `buildSessionInfo` 对齐）：`createdAt` = session header 时间（**不是** 文件 birthtime/mtime——复制/恢复文件会改它）；`modifiedAt` = user/assistant 消息最大活动时间（message 数值 timestamp 优先、entry timestamp 兜底、无消息=created，custom/toolResult 一律不算）；header 读不出来才 `fallbackSessionTimes`（文件 mtime → 当前时刻） |
| `src/session/single-flight.ts` | `KeyedSingleFlight<T>` | 按 key 的并发 single-flight：同 key 在途复用同一个 Promise，settle（成败都算）后**只清自己那条**（旧 Promise 不删后继请求）；`PiBackend.openSession` 按**规范化绝对路径**用它，保证同一会话文件并发 open 只构造一次 |
| `src/settings/quota.ts` | `QuotaService`、`makeQuotaService` | opencode-go 套餐额度：官方 API + 5min TTL 缓存（无 key null / HTTP 失败带 error 空窗体） |
| `src/lan/projector.ts` | `SessionProjection`、`seedProjection`、`applyEvent`、`deriveView` | LAN 会话投影 = **sanitize 事件流驱动的 shared reducer 态**（单一事实源）+ 非 reducer 底座（name/cwd/stats/lastActivity/pendingPermission）；agentActive/todos/currentTool/assistantTail/lastError 全派生，无第二状态机 |
| `src/lan/sanitize.ts` | `sanitizeSessionEvent/Message` | LAN 出网净化；事件白名单 = shared `REDUCED_EVENT_TYPES` − LAN 排除集（auto_retry_*/stream_guard_tripped，单一事实源派生） |
| `src/session/messages.ts` | `toSessionMessages`、`resolveRecallEntryId`、`resolveForkEntryId`、`block*` | pi 消息 → SessionMessage 解析（纯函数，可独立单测）：toolResult 回填、show_image/subagent 提取、edit `details.patch` → `SessionToolCall.diff`、entryId 配对（user·assistant 分表防同 ms 碰撞）；fork/recall 目标解析 |
| `src/session/traces.ts` + `trace.ts` | `SessionTraces`、`TraceRecorder` | trace 生命周期 / 批量落盘（500ms/128 条 flush；单事件 >512KB 截断标记、按字节轮转——加固背景见 PITFALLS 0.4.6） |
| `src/session/event-slim.ts` | `slimMessageUpdate`、`slimBulkyEvent` | 事件瘦身（emitEvent 单点）：剥流式 delta 携带的全量快照、剥 image base64/截断超长 text；details 与终态消息不动（事故背景见 PITFALLS） |
| `src/session/stream-guard.ts` | `StreamGuard` | 流式熔断（emitEvent 单点）：连续空白 >8KB 或单消息 >2MB → abort + 丢弃后续增量；双路径清理防 Map 泄漏 |
| `src/session/rates.ts` | `EventRateTracker` | 每会话事件速率统计（60s 滑窗），心跳/崩溃快照数据源；prune 防泄漏 |
| `src/session/naming.ts` | `autoNameSession` | 首条用户消息 message_start 即取首行做标题（skill 命令先还原 `/skill:name` 投影，有测试） |
| `src/session/naming.ts` | `autoNameSession` | 首条用户消息 message_start 即取首行做标题（skill 命令先还原 `/skill:name` 投影，有测试） |
| `src/session/ui-context.ts` | `makeUiContext(deps?)` | `ExtensionUIContext` 桥接（deps 全可选：dialogs/onNotify/onEditorText）：select/confirm/input/editor → `ExtensionDialogHost`（无 deps 退回契约取消值），notify/预填走回调；confirm 不再路由 PermissionGate（D7）；setTheme 诚实返回 `{success:false}`；**theme 必须是真实 `Theme` 类实例**（假对象会让扩展 `theme.fg()` 抛错、MCP 全连不上）；`extensionNameFromStack` 来源归因纯函数。SDK 接口变化时在此补新成员。全景见 [`docs/extension-ui.md`](extension-ui.md) |
| `src/session/extension-dialog-host.ts` | `ExtensionDialogHost` | 扩展对话框宿主（每会话一个，与 PermissionGate 平行）：ask 分配 `dlg-<sessionId>-<n>` 并 dispatch 请求；timeout/signal 到点自动按契约取消值结算（裁决在 backend）；respond 用户应答（confirm fail-closed）；dispose 全部 sessionClosed 兜底。GUI-only 不进 LAN |
| `src/permissions/gate.ts` | `PermissionGate` | 权限确认队列：allow/deny/allowAlways/allowDir + kind/suggestDir 元数据；respond 前供 PiBackend 持久化；listPending 供 LAN 只读快照 |
| `src/permissions/index.ts`（+ bash-chain/pattern/config/tmp-zone） | `evaluateBashCommand` 等 | 逐工具权限规则引擎：allow/ask/deny × 通配模式；bash 命令链取最严段；自保护（permissions/workspaces/auth/trust 四文件）；tmp-zone = 临时区判定 + rm 豁免（纯函数）。已知天花板：xargs/find -exec/python -c 不覆盖 |
| `src/permissions/extension.ts` | `makePermissionGateExtension` | 权限门控内置扩展（tool_call 钩子 + 确认通道 + 会话权限模式分支）。求值链：① deny 直接 block → ② 临时区 → ③ 多根边界（projectRoot ∪ workspaces roots）读写分离（读默认放行/写默认确认）→ ④ 项目记忆 allowed[] → ⑤ ask；`getMode` 每次调用实时读，fullAccess 档下 ①⑤ 降级为审计 + 放行（spec permission-mode） |
| `src/permissions/audit.ts` | `PermissionAuditLog`、`permissionAuditPath` | fullAccess 高危审计：JSONL 追加写 `~/.pi/agent/permission-audit.jsonl`（含 sessionId/boundary），超 1MB 截头保尾；写失败不阻塞工具调用 |
| `src/project/trust.ts` | `TrustGate`、`resolveProjectTrust` | 信任决策链：无资源→信任 → trust.json → defaultProjectTrust → 两选项弹窗（信任/不信任均落盘）；同 cwd 在途询问去重 |
| `src/project/trust-loader.ts` | `ProjectResourceLoader` | 两阶段资源加载：先用户级（projectTrusted:false）→ 信任决策 → 按结果重载 |
| `src/project/workspace-store.ts` | `loadWorkspaces`、`addWorkspaceRoot`、`addAllowedPattern` 等 | `~/.pi/agent/workspaces.json`：per-project `roots[]`（「允许此目录」写入，多根边界）+ `allowed[]`（allowAlways 模式键，LRU 200） |
| `src/project/files.ts` | — | @ 补全的文件列表（walk 排除 node_modules/.git/dist 等，5000 上限 30s TTL） |
| `src/tools/webfetch/` | `makeWebFetchTool` | 内置 webfetch 三模块：`ip-guard.ts`（SSRF 防护，独立成文件便于审计）/ `html-to-text.ts` / `tool.ts`（抓取循环+截断+github blob 重写） |
| `src/tools/show-image.ts` | `makeShowImageTool` | 内置 show_image：`paths` 数组 1-9 张/次；图片只走 `details`（模型不可见、jsonl 自动持久化），`content` 只回一句文本；路径规整 ~ 展开 + unicode 空格归一 |
| `src/tools/todo.ts` + `todo-reminder.ts` | `makeTodoTool`、`makeTodoReminderExtension` | todo 工具（全量替换协议，`details.todos` 供 UI）+ 恢复扩展（context 钩子注入 `customType:"todo-reminder"`——用 context 而非 before_agent_start：overflow willRetry 同 run 重试也覆盖） |
| `src/tools/subagent/` | `makeSubagentTool`、`runSubagent`、`applySubagentMutex`、`resolveSubagentPreferBuiltin`、`discoverAgents` | 内置进程内 subagent：single `{agent,task}` + parallel `{tasks[]}` cap 8/并发 4；子代理 = 共享 modelRuntime 的隔离 `AgentSession`（资源最小化 + 权限桥父 gate，完成等 `agent_settled`）；**思考档位链**：设置页覆盖 > agent frontmatter > SDK 默认链（显式传 `thinkingLevel`，实际生效值回传 `SingleResult`）；会话文件落 `sessions-subagents/`（打开即只读）；**参数 schema 必须拍平单 object**（DeepSeek 对顶层无 `type:"object"` 直接 400，严禁顶层 Union/Intersect）；互斥 = 同名覆盖 + `subagent_*` 家族停用（发 `subagent_mutex` 事件）；runner 转发子会话原生事件（检视页实时收流）；agent 定义：内置 scout → user `~/.pi/agent/agents/` → project `.pi/agents/`（仅 trusted） |
| `src/tools/context-evaporation/` | `makeEvapExtension`、`readContextManagerMode`、`writeContextManagerMode` | 内置上下文蒸发扩展（**默认开启**，二态蒸发/off）：context 钩子把到龄工具输出按四级水位线蒸发为 stub（零 LLM、决策单调持久化保 KV cache）；核心三文件（types/estimate/evaporate）零 SDK/零仓库 import（replay `--core` 同构验证）；二态配置单 key 单一写者（写侧顺带清遗留键）；调参走 `scripts/replay-evaporation.mts`；批次观测 = log + trace_custom 行 |
| `src/tools/channel-watch/` | `makeChannelWatchExtension` | 内置跨会话频道协作扩展（默认开）：订阅 `.local/agent-work/channel/<topic>/`，**消息 = 意图：写文件 ≠ 通知，channel_post 工具才唤醒**（根治一次任务写 N 文件 = N 唤醒）；防环三层（自写窗口 + hash 去重 + 乒乓上限暂停）；**持久内容游标**（`channel-subs` 快照 = topics + `cursors`，`null` = 确认时文件不存在、key 缺失 = 旧载荷未知基线）：首次订阅先记基线，session_start 就绪后逐 topic 对账补投**一次**（离线期间的新消息不丢、不重复），live 投递推进游标；**自写抑制仅在「写前磁盘版本 == 游标」时推进**，否则保留 pending（否则会把对端已写未提醒的内容吞掉），paused 不推进（重新 subscribe 合并补投一次），文件删除推 null 不唤醒，`unsubscribe` 删游标；**跨 await 续体一律复查 active/trusted/订阅**（退订/shutdown 落在读 hash 或 watcher 启动期间不产生幽灵投递/游标/孤儿 watcher）；只接受 `<topic>/MESSAGES.md`（嵌套同名文件不污染游标）；watcher `ensureWatcher` 为 single-flight（失败可重试，shutdown 不留孤儿）；`closed:true` 终态信号（查收后退订仍靠 skill 协议）；**有效订阅快照上报 backend**（`onSubscriptionsChanged`：enabled+trusted 才计入，disabled/untrusted/shutdown 上报空集，回调异常只记日志）→ 有订阅的会话不被 renderer 自动 GC；分模块 config/init/guard/watcher/subscriptions/post/tools/extension；配套 skill channel-pickup/design-handoff |
| `src/settings/settings.ts` | `SettingsService` | provider/模型/凭证读写（key 走环境变量引用，绝不落明文）。listProviders 默认本地 refresh（`allowNetwork:false`），显式 forceNetwork 才联网；custom provider 增改走 `buildCustomEntry`（未设字段不落盘）；模型列表留空 = 覆写 baseUrl 共享官方列表；`setProviderBaseUrl` = 内置 provider 端点覆写专用；移除凭证走 `runtime.logout()`（直接删文件残留内存态）；`apiKeyLogin` 标记 = 内置 provider 有交互式 api_key 登录（UI 显示「登录」入口） |
| `src/settings/model-prefs.ts` | `ModelPrefsService` | `model-prefs.json`：隐藏模型 + 停用 provider + per-agent 子代理模型/思考深度（读侧白名单，空 map 不落盘）+ `subagentPreferBuiltin` 执行器开关（缺省/脏值 = true）；`listModels()` 唯一出口过滤 |
| `src/settings/login.ts` | `LoginService` | provider 交互登录桥接：AuthInteraction → IPC 事件（prompt 挂起等 renderer 应答；浏览器先到则拒挂起 prompt）。支持 OAuth + api_key 交互登录（如 Google Vertex）；`filterAuthSelectOptions` 对 google-vertex 剔除必败的 api-key 选项（Vertex 不接受 API key，见 PITFALLS） |
| `src/packages/admin.ts` | `PackageAdmin` | 社区包搜索/安装/卸载/已配置清单 + 装卸后对非流式会话热重载（对齐 CLI /reload）；npm ENOENT 转带哨兵的可读错误 |
| `src/packages/catalog.ts` | `fetchPackageCatalog` | pi.dev 目录抓取：无 JSON API，解析 SSR HTML 的 `<article data-package-card>` |
| `src/lan/server.ts` | `LanObserverServer` | 局域网观察与可选远程控制：userData 配置 + token 轮换、HTTP+SSE（timingSafeEqual、5 客户端上限、delta 微批合帧）；远程发送/停止/允许一次或拒绝由独立 `remoteControl` 开关保护；projectEvent = 投影更新与帧广播同点（快照带 in-flight 容器，重连无缝） |

**可观测性**：每会话事件 trace + 关键操作日志（create/open/close/prompt/abort/compact）；main 进程还监听 renderer 崩溃/unresponsive/console。排查 UI 状态问题：`npx tsx scripts/replay-trace.mts --last` 确定性复现。

**何时改这里**：权限逻辑、项目信任、自动命名、uiContext 桥接、provider 设置、会话管理。

## packages/desktop — Electron 应用

### main/

| 文件 | 职责 |
|---|---|
| `src/main/index.ts` | app 生命周期 + 装配：initLogging / `pi-bg://` 协议 / renderer 崩溃钩子 / `new PiBackend()` / LAN / `new UiPluginManager()` / registerIpc / updater / 建窗。**首三行必须 import `./pi-package-dir` + `./dev-agent-dir` + `./fix-path`**；render-process-gone 自动 reload（30s 内 ≥3 次停手弹窗，崩溃时输出 incident snapshot）；before-quit 逐项 dispose |
| `src/main/console-dedup.ts` | renderer console 错误签名去重（首条全量/重复计数/阈值与周期汇总），纯函数可单测 |
| `src/main/fix-path.ts` | GUI 启动 PATH 修复：Finder/Dock 启动 PATH 无 Homebrew，spawn npm 会 ENOENT；同步追加常见 bin 目录 + 异步 `$SHELL -ilc` 合并（须在 spawn 任何子进程前 import） |
| `src/main/pi-package-dir.ts` | 打包态 `PI_PACKAGE_DIR = resources/pi-package`（SDK `getPackageDir()` 最优先读它，不缓存）：pi 官方 docs/examples 经 extraResources 装入 |
| `src/main/dev-agent-dir.ts` | dev/预览态数据隔离：userData 重定向 `*-dev` 后缀 + `PI_CODING_AGENT_DIR = ~/.pi/agent-dev` + 五配置一次性种子拷贝（正式目录零写入） |
| `src/main/daily.ts` | 日常空间工作台目录（`~/.percho/daily`，全部日常会话的固定 cwd）+ 懒创建；信任链无资源自动信任不弹窗；dev/正式共享工作区（会话列表按 agent dir 天然隔离） |
| `src/main/ipc/index.ts` | `registerIpc` 组合入口 + backend 事件/updater 状态转发（`forward()` 单行透传）+ UI 插件热重载 watcher 启动。**新增通道：进 `shared/src/ipc-channels.ts` 对应域子表 + 域文件 handler 一行，preload/main 自动接线** |
| `src/main/ipc/{sessions,settings,packages,app,ui-plugins,lan}.ts` + `invoke.ts` | 各域 handler（`registerInvokeHandlers(子表, {...})` 表驱动注册；ui-plugins 域 handler async await 落盘后才返回；17 非透传 handler 的逻辑体就在各域 map 内） |
| `src/main/ui-state.ts` | ui-state.json 读写（JsonStore 原子写；补丁式合并 + normalize 补缺省）。**v10 起没有 tabs.json**：不再持久化「打开列表」 |
| `src/main/background.ts` | 背景图选图（dialog → 拷贝 `userData/backgrounds/` 并清理旧图） |
| `src/main/window.ts` | BrowserWindow：sandbox + preload；启动底色跟随主题防白闪（已解析主题经 `?theme=` query 传 renderer）；窗口框架按平台分流（mac hiddenInset / Win frameless+titleBarOverlay / Linux 原生）；**关窗语义按平台**：macOS 红点/⌘W = 隐藏窗口（`close` 事件 `preventDefault + hide()`，`index.ts` 的 `before-quit` 调 `markQuitting()` 放行 ⌘Q；`activate` 恢复 show+focus）；Windows 点 ✕ = 退出（微软惯例不变），**仅当渲染端接管了退出确认（`app:setQuitGuard`）时拦下弹确认窗**，并起 1.5s 兑底计时等 `app:quitDialogShown` 回执（超时/未接管/页面已销毁一律放行——见 PITFALLS）；`did-start-loading` 时清 guard（重载期不拦）；导出 `resolveTheme`/`applyChromeTheme`/`markQuitting`/`setQuitGuard`/`ackQuitDialog` |
| `src/main/path-target.ts` | 文件路径归一（纯函数，含 11 例单测）：剥成对包裹符与 `:行:列`/`#L12` 锚点 → `file://` 与 `%` 解码 → `~` 展开 → 相对路径按会话 cwd 解析；`resolveExistingPath` 带存在性检查（不存在抛 `Path not found: <绝对路径>`）。消费方 = `app:resolvePath`/`openPath`/`revealPath` 三通道（文件行右键菜单） |
| `src/main/ui-plugins/config.ts` | `ui-plugins.json` 读写（normalize 白名单；assignments 指向失效插件保留） |
| `src/main/ui-plugins/build.ts` | 插件 esbuild 构建器：`loadEsbuild` 懒加载 + `ESBUILD_BINARY_PATH` 指向 asar.unpacked 真实二进制（打包态坑，升级 esbuild 前重评）；react 系四个 specifier 重写到 `window.PerchoUI` shim（**与 renderer host-api.ts、resources/percho-ui.d.ts 逐名一致**）；图片/音频资产 dataurl 内联（CSP img-src / media-src 均放行 data:） |
| `src/main/ui-plugins/manager.ts` | UiPluginManager 编排：scanAll / ensureBuilt / fs.watch 300ms 防抖热重载 / config（manifest 校验与 contributions 过滤在 manifest.ts，种子在 seeder.ts，目录树工具在 fs-tree.ts） |
| `src/main/ui-plugins/{manifest,fs-tree,seeder}.ts` | manifest 校验+过滤+读取（纯函数域）/ copyTree+sameTree+newestMtime / pluginsDir+seedBuiltinPlugins+seedDocs+uiPluginsResourcesDir（从 manager 拆出，D7） |
| `src/main/renderer-watchdog.ts` | `attachRendererWatchdog(backend)`：崩溃熔断+自动 reload（短窗高频转人工对话框）/ console 错误签名去重 / 60s 心跳+临终快照（从 main/index.ts 抽出，index 回归纯装配） |
| `src/main/lan.ts`（+ `lan-icon.ts`、`ipc/lan.ts`） | LAN observer 接线；观察页 = `src/lan-web/` 独立 vite 单文件产物，`?raw` 内联进 main bundle（**dev 下重 build lan-web 后需重启 dev 实例**，产物不在 electron-vite watch 集） |
| `src/main/git.ts` | git 分支查询/切换三通道 |
| `src/main/update-policy.ts` / `updater.ts` | 更新决策纯函数（不 import electron 可单测）/ electron-updater 封装：发现新版只提示，点击才下载，下载完点「重启」安装；mac adhoc = manual 模式跳 release 页；定时静默检查只查不下载；autoUpdater 用 createRequire 取（CJS 导出） |

### preload/

`src/preload/index.ts` — contextBridge 暴露 `window.pi`（`PiApi` 实现，含同步 `platform`）。必须保持 CJS（见硬约束）。

### renderer/（React 19 + Tailwind 4 + Zustand）

| 文件/目录 | 职责 |
|---|---|
| `main.tsx` / `App.tsx` | 入口 / 视图切换（chat/projects）+ 事件桥：onEvent → `EventConflator` rAF 合流 → transcript store（桥在 `hooks/use-session-event-bridge.ts`）。订阅纪律：App 只订阅原始值（子树无 memo，订阅 transcript 对象会随每条流式 delta 全级联） |
| `bootstrap-theme.ts` | 首帧前写 `data-theme`（读 `?theme=` query，防开屏闪色） |
| `monaco-contribs.ts` | monaco worker 接管 + 懒加载服务补注册（出现新 UNKNOWN service 报错时按同法在此补模块） |
| `splash-dom.ts` / `splash.ts` / `styles/splash.css` | 开屏动画三件：DOM/粒子参数（`DOT_COUNT`）→ 时长与单次标记（sessionStorage）→ 全部样式与收场编排（改视觉只动这三个文件） |
| `api.ts` | `getPi()`：window.pi 类型化访问 |
| `lib/thinking.ts` | `THINKING_LEVELS`/`ThinkingLevel` re-export（单一事实源在 shared `src/thinking.ts`）+ `clampThinkingLevel` 就近向上收敛（仅 renderer UI 用；backend 不 import，交 SDK clamp） |
| `lib/daily.ts` | 日常空间目录 renderer 缓存：`initDailyDir`（App 启动调一次，幂等）+ `isDailyCwd` 同步判定 + `setDailyDirForTest`；各处共享，不散落路径字符串 |
| `lib/sidebar-groups.ts` | 左栏纯派生层（有单测）：`mergeSidebarSessions`（**历史 + 内存会话合并**：按 `sessionId` 去重、内存覆盖历史、历史保序；同 ID 走 `mergeSessionMeta`——运行态字段（name/model/active/messageCount）以内存为准，但 **`createdAt` 始终取历史权威值、内存 `modifiedAt` 缺失时保留历史值**，否则排序键会从 `modifiedAt` 掉到 `createdAt`、行在打开/卸载时伪移动；刚创建还没落盘的会话由此进左栏）+ `primaryNavigationSessions` / `deriveSidebarNavigation`（**左栏生产装配，Sidebar 与单测走同一条路**：合并 → 按 `isPrimaryNavigationSession` 过滤只读子会话 → **同一份集合**同时喂给 `deriveProjects` 与 `deriveSidebarGroups`，否则只读子会话会凭空长出一个项目组）+ `deriveSidebarGroups`（合并结果 + 项目表 → 日常/项目分组、置顶排序、搜索过滤、展开态推断；**默认展开组只看显式 `activeCwd`（新会话页 = draft.cwd），不从 sessions 反查 active**）+ `toggleInList`（置顶切换）+ `toggleExpandedGroup`（第 4 参 `touched` 定起点：没操作过用派生层默认集，已操作过用用户记录——**空数组合法表示全部折叠**）。「项目」小标 v7 起不可折叠，不再有 `PROJECTS_GROUP_KEY` 这类专用 key |
| `lib/session-visibility.ts` | 导航可见性判据单一事实源：`isPrimaryNavigationSession(session)` = `readOnly !== true`。只读子会话（tmp subagent 检视）**只从导航投影过滤**——仍留在 `sessions` store（事件/transcript/关闭都靠它），但不进左栏分组/计数/搜索与顶栏胶囊。导航派生与 `selectBarSessions` 共用 |
| `lib/session-gc.ts` | 会话内存驻留策略（**纯函数，有单测**）：`pickUnloadCandidates`（保护/活跃/刚用过 → 剔除；剩余按最久未用排序，保留 K 个，超的与晾过 `idleTimeoutMs` 的一并作候选）+ `isProtected`（保护条件唯一事实源：**有频道订阅（`hasChannelSubscriptions`，订阅 = 明确驻留语义，卸载会停 watcher）** / 0 消息 / agentActive / 待审批 / 待应答 / 未读绿点 / 压缩中 / 排队跟发；**权限模式曾在清单里，D7 改成按会话持久化+打开时恢复后已移除**）+ `GC_DEFAULTS`（K=3、fresh **3s**、idle 5min）。不 import React / 不调 IPC |
| `lib/session-gc-run.ts` | 一轮 GC 的**编排**（依赖全注入，有单测）：先拉「有频道订阅的已加载会话 ID」快照 → 映射进 `hasChannelSubscriptions` → 纯策略层算候选 → 逐个再确认（活跃/已关跳过）后 `unload`；**fail-safe：快照拉取失败 = 保护范围未知 → 整轮跳过一个都不卸**（不退化成「让 backend 拒绝一次」，否则每轮每会话一次无效 IPC）；后端 `closed=false` 记 `refused` |
| `lib/use-session-gc.ts` | 内存策略接线层（薄）：构建依赖调 `session-gc-run.ts` 的一轮编排 + 挂载跑一次 + **20s** 兜底 tick（实测：仅靠它时收敛延迟 ≤ 一个 tick） + 只订阅 `sessions`/`activeSessionId`（**不订阅 `transcript.bySession`**，它每 token 都变）+ 轮内不重入；K=3 常量在这里 |
| `lib/diagnostics.ts` | `buildDiagnosticsText`（会话诊断纯文本，供「复制诊断信息」用；从 `components/projects/` 移入） |
| `stores/sessions.ts` | 会话列表/当前会话/cwd/模型/权限模式（`permissionModes` map，缺 key = default）。**新会话 = renderer 全局唯一 draft**（`newSessionDraft`：cwd/model/thinkingLevel/permissionMode + 两个**分字段** `modelResolved`/`thinkingResolved` 位 + 内部 `generation`；不进 `sessions`、不落盘、不触后端）：`activateNewSessionDraft(cwd?)`（顶栏「＋」/启动；已有 draft 只激活、不覆盖配置，**只有从真实会话回到新会话页时领号**——已在 draft 页不领号，否则在途 promotion 结果会被误判成「不是最新意图」）/ `setDraftCwd`（项目选择器；同时 `rememberCwd` + 信任前置）/ `setDraftPermissionMode`（纯 renderer）。**`createSession()` = promotion**（首条消息/斜杠命令）：吃 **draft 入口快照**（cwd/model/thinking/permission 同一时点冻结）、single-flight **按 `generation` 隔离**（D1 已消费仍在等权限 IPC 时新建 D2 会另发一次）、成功消费 draft 并把 draft 权限档位应用到新会话、失败保留 draft 与内容（可重试）、迟到结果只落 `sessions` 不抢焦点。**不变式：`activeSessionId === null` ⇒ 必有 draft**（store 初始化即建一份；`closeSession` 关掉最后一个会话时补种；promotion 迟到且此刻在新会话页时补种），且此时 `cwd` **严格镜像 `draft.cwd`（含 null）**。**导航 latest-wins**：用户导航动作先领进程内单调 `activationSeq` 令牌，异步返回时只有仍是最新令牌才写 `activeSessionId/cwd/rememberCwd`（过期的只落数据：meta 进 tabs、bundle 装载）；`switchSession`/`activateNewSessionDraft` 同步领号，`openFromHistory`/`createSession`(promotion)/`forkSession` 入口领号，`closeSession` 的 active 回退是关闭副作用**不领号**。**`openFromHistory` 走共享 open pipeline**（`openInFlight` 按规范化 filePath 去重：同文件双击只发一次 IPC、失败只 toast 一次、settle 必清 key；`bundleInFlight` 再按 sessionId 去重 bundle）。`createSession` 失败返回 null——**调用方必须用返回值定位新会话，不能读 `activeSessionId`**（创建期间用户可能已切走）；信任前置 ensureProjectTrust（trustVersion 触发重拉）；打开（含从历史按需打开）/fork/撤回统一 `loadSessionBundle` 四件套（history→queue→todos→permissionMode 对齐后端）；**`selectBarSessions`（v8）算顶栏展示集 = 严格置顶表（meta 从 tabs → `allSessions` 兜底；**只读子会话被防御性过滤**，防脏置顶/手改 ui-state）**；**v10 起不持久化打开列表**——启动纯空（新会话页 = 那份唯一 draft），会话只在你点开时才加载，退出即清（与 pi 原生 `AgentSessionRuntime` 的"单会话按需替换"对齐）；切会话/打开/选目录三处调 `rememberCwd` 记住**上次项目目录**（`lastCwd`，只记目录不恢复会话）；**`loadSessionBundle` 末尾按 `sessionPermissionModes` 恢复档位（await IPC，保证「打开完即正确档位」）**；**`loadModels`**：模型列表加载后按 draft 的分字段 resolved 位补默认值（用户改过的字段不被覆盖）并按模型能力夹紧档位；**会话内存驻留策略**：`lastUsedAt` LRU 打点 + `unloadSession`（自动卸载专用入口，走 `closeSession(id, intent:"gc")` 让后端区分自动 GC 与用户意图；受保护会话由纯策略层排除），接线在 `lib/use-session-gc.ts`（App 挂一次）。**GC 选择竞态（D5）**：`closeSession` 在 `closed=true` 后、清本地状态前复检 `activeSessionId === sessionId`（仅 intent=`gc`）——命中则只重建 backend 会话（`loadBundle:false`，不重载磁盘历史、不 reset transcript、不领新令牌）、按 renderer 真值拉回权限档位（失败则回落 default + 提示），返回 `{closed:false}`（GC 视为本轮没卸成）；reopen 失败才按常规关闭清理 |
| `stores/transcript.ts` | re-export shared reducer + per-session 字段（agentActive/unseenCompletion/todos）；reducer 细节见 shared `src/transcript/` |
| `stores/event-conflator.ts` | 流式事件合流：纯追加型 delta 按会话/类型拼接 + rAF 每帧最多一次 flush，其余事件边界透传保序（可注入调度器，有测试） |
| `stores/drafts.ts` | 输入内容（文本/图片/slash 胶囊/@ 引用 attachments/选中引用 quotes）按会话持久：真实会话用 sessionId、**新会话页固定用 `NEW_SESSION_DRAFT_KEY`（`__new__`，全 renderer 唯一一份，不持久化）** + `COMPOSER_FOCUS_EVENT`（撤回回填/点「＋」后聚焦输入框） |
| `stores/settings.ts` / `catalog.ts` / `provider-login.ts` | 设置域（providers + 上下文管理/channel-watch 开关，乐观更新回滚；permissionGateOff = 手改 permissions.json 卸载门控的逃生舱态只读感知）/ 社区包目录（300ms 防抖 + seq 防陈旧）/ OAuth 登录状态机（**取消时机 = LoginDialog 卸载 cleanup**；先订阅事件再 invoke） |
| `stores/projects.ts` / `theme.ts` / `ui.ts` / `ui-preferences.ts` / `update.ts` / `ui-plugins.ts` / `toasts.ts` / `app-quit.ts` | 会话历史与项目表（`load` 有 **latest-wins** 单调 `loadSeq` 守卫：更晚的 load 一旦发起，旧请求的成功/失败都不写 `allSessions/loading/loaded`；`deriveProjects`：手动添加的按时间倒排；`deriveSessions`：置顶分区在左 + 其余按最后活动倒序；`deleteSession` / `deleteProject` / `openSession`（已加载会话走 switchSession，否则 openFromHistory）/ `applySessionName`）/ 主题与背景（init 在 render 前 await 防闪烁）/ todo 面板展开 + diff 侧栏开关（内存态）/ **左栏偏好 `barSessionsVisible` / `sidebarCollapsed` / `expandedGroups` + `expandedGroupsTouched`（成对语义：false = 从没手动开合过 → 走默认推断，true = 完全以 `expandedGroups` 为准，**空数组 = 全部折叠**；旧文件缺字段时按记录是否非空推断）/ `pinnedProjects` + 中央动画开关 + 置顶会话 `pinnedSessions`（v8 起它同时就是顶栏胶囊内容与顺序，拖动排序走 `reorderPinned`）+ **`sessionPermissionModes`（D7：按会话记住的权限模式，只存非 default；`rememberPermissionMode` / `forgetPermissionMode`）** + 上次项目目录 `lastCwd`（App 启动预填 cwd，只带目录不恢复会话）**（均持久化 ui-state；删会话时 unpin 清理）/ 更新态 / UI 插件面板 / 全局 Toast（顶栏右侧，非阻塞自动消失；扩展 notify 走 pushExtension：同源同文 8s 去重 + 可见栈 3 溢出折叠） |
| `hooks/` | `use-context-usage`（上下文用量，事件驱动刷新）/ `use-language` / `use-session-state`（useSessionReadOnly/useSessionBusy 收敛）/ `use-session-event-bridge`（App 事件桥装配层专用） |
| `plugins/` | UI 插件运行时：`slots.ts`（槽位名+props 契约单一来源）/ `registry.ts`（zustand：overrides + contributions 堆叠 + headless activate/cleanups + 崩溃计数/loadNonces）/ `Slot.tsx`（总开关门控 + PluginBoundary 包裹）/ `RegionHost.tsx`（区域挂载点，容器语义）/ `PluginBoundary.tsx`（class 错误边界，崩溃回退）/ `host-api.ts`（`window.PerchoUI` 挂载，main.tsx render 前 import）/ `loader.ts`（initUiPlugins/reloadAll/computeAssignedSlots） |
| `i18n/` | zh/en 字典 + `useT()`（文案改这里，双字典） |
| `styles/globals.css` | Tailwind 入口 + 主题 token（`bg-canvas/bg-surface/ink 灰阶/shadow 三档` 等；组件禁写死色值，一律语义 token）+ markdown/滚动条/动画样式段 |

### components/（按域分目录）

| 目录 | 内容 |
|---|---|
| `chat/` | **MessageList**（底部跟随 + 脱离回底；行模型 `useMemo`，轮末行定位规则在 shared chat-rows；**挂载窗口**见 `mount-window.ts`）/ **SelectionToolbar**（对话区选中文字浮出菜单：添加到对话/新会话继续）/ **MessageItem**（纯分发壳）+ `message-actions.tsx`（复制/Fork/撤回按钮）/ **UserMessage** / **SystemMessage**（compaction 分割线 + mutex 通知）/ **AssistantMessage** / **Markdown**（markstream-react 流式丝滑渲染，fade 关闭避免合成层闪烁；代码块只读编辑器关闭自动 decoration，样式覆写在 globals.css `.markdown-body`，见 PITFALLS）+ **MermaidBlock**（接管 markstream 的 mermaid code_block：loose 模式 + 悬浮工具栏 + 渲染失败报错卡；见 PITFALLS）/ **ToolCallCard** / **SubagentRunCard**（独立行，有 sessionFile 可点开子会话）/ **TodoPanel**（呼吸灯 + 展开 morph 同一容器）/ **MetaGroup**（memo 折叠组 + 圆点行/分类统计行）+ `use-sweep-highlight`（统一扫光）+ `use-shown-working`（working→worked 滞后缓冲）/ **PreviewTicker** + `activity-ticker`（工作中预览行调度）/ **StreamingMarquee**（溢出 tail-follow，位移用 shared marquee-motion）/ **ImagePreview**（全屏多图，portal 到 body）/ **ErrorNote**（统一报错卡）+ **RetryNote**（自动重试瞬态行）/ **CenterOrb** + `center-orb-draw`（中央状态动画，绘制闭式函数）/ **TurnDiffChip**（轮末计时行 + 文件变更 chip；计时器运行中 1s 心跳跳动/定格；文件行右键 + hover「⋯」→ 路径菜单 `ui/FilePathMenu`）/ `meta-summary-label`（i18n 胶水） |
| `diff/` | **DiffSidebar**（右侧变更浮层抽屉：固定宽度 + transform 合成动画，不参与聊天列布局；按轮分组 unified diff + 内嵌 BranchRow git 分支行；开关在 SessionTabBar；`cwd` 下传给卡片做相对路径基准）+ DiffFileCard（卡片头右键 + hover「⋯」→ 路径菜单） |
| `composer/` | **Composer**（装配层 ~330 行，键盘事件分发）+ 三 hook：`use-composer-send`（ensureSession 懒创建/followUp 排队/停止先 clearQueue/发送失败草稿回填）、`use-slash-menu`（命令拉取+胶囊回填+导航）、`use-at-completion`（@ token 探测/续钻/胶囊弹回）+ 展示件 QueueBar/ImageTray/AttachmentChip/**QuoteChip**（选中引用胶囊）/SendErrorBar + **ModelPicker** / **ThinkingPicker**（按模型 thinkingLevels 过滤+clamp）/ **PermissionPicker**（会话权限模式 chip：默认/完全访问）/ **SlashMenu** / **AtMenu** / **ContextRing** + 纯函数 `slash-filter`/`at-files`/`send-error`/`quote`/`model-filter`（各有测试） |
| `session/` | **SessionTabBar** + SessionTab/TabPill（**v8：顶栏胶囊 = 置顶会话（不看 tab 开没开），严格只含置顶**，顺序就是 `pinnedSessions`；未置顶会话只在左栏；空态一行 12px `ink-faint` 提示；状态收拢到头像图标；dnd-kit 拖拽排序（改的也是 `pinnedSessions`），DragOverlay ghost + 轴锁定；拖拽期间退出 drag-region；**最左 = 左栏开合按钮 `PanelLeftIcon`**；胶囊右键 → `ui/ContextMenu`「重命名 / 置顶」；叉叉 = 取消置顶 + 从顶栏清除）/ **RenamePopover**（重命名浮层：锚在胶囊/指针锚点，160ms 进场 / 120ms 退场 + Enter/点外提交/Esc 取消）/ **SessionAvatar** + `session-status`（头像底色语义 + 状态/标题纯逻辑，顶栏与左栏共用；`SessionAvatar` 已无引用，留作备用）/ `session-menu`（菜单可用性与动作：`sidebarMenuKind` 定形态（普通 / 无菜单）、只读会话不给菜单、置顶只动 `pinnedSessions`、重命名落盘（**同步 tabs 与历史列表两份拷贝**）+失败 toast、复制诊断、删除会话；顶栏胶囊与左栏会话行共用）/ **ProjectBranchPicker**（从 `projects/` 移入的项目/分支选择器 chip；**只在无 active（新会话页）显示**，真实会话的项目创建时已绑定不可改）/ **DockSlot**（底部交换槽仲裁：权限 > 扩展对话框 > Composer）/ **ApprovalDock**（权限审批：async respond 成功才移除面板，失败保留重试）/ **InteractionDock**（扩展对话框四卡 select/input/editor/confirm：键盘 ↑↓/Enter/数字/Esc + 倒计时显示，裁决在 backend）/ **TrustDialog**（项目信任两选项）/ **UpdateButton**（顶栏更新按钮） |
| `settings/` | **SettingsDialog**（PANELS 注册表；分类 = 静态 + 插件 settings.panel 贡献动态拼接）/ **GeneralPanel**（语言/上下文管理二态/channel-watch 开关）/ **AppearancePanel**（顶部 Tab 分栏：「基础」=主题三段/背景图/**显示顶栏开关**/中央动画，「UI 插件」= 原独立分类并入的 UiPluginsSection：总开关/插件卡/槽位指派，设计稿 .local/design/ux/appearance-ui-plugins）/ **SkillsPanel** / **McpPanel**（SDK 0.84 无 MCP，占位）/ **ExtensionsPanel** + `extensions/`（目录浏览/安装/卸载，subagent 包安装两段式确认）/ **UiPluginsSection**（挂在 AppearancePanel 的 UI 插件 Tab 下） / **LanObserverPanel** / **AboutPanel** / `providers/`（ProvidersPanel + ProviderRow 操作全图标化 / LoginDialog（交互登录对话框：OAuth + api_key 交互流）/ CustomProviderForm + ModelRowsEditor（逐模型行编辑器）/ BuiltinProviderEditForm（内置端点覆写）/ SubagentPanel（子代理执行器开关 + 逐代理模型/思考深度偏好）+ `model-rows` 纯函数） |
| `sidebar/` | **Sidebar**（常驻左栏容器：取 store 数据（历史 + 内存会话 + `activeCwd = store.cwd`）→ 调 `lib/sidebar-groups` 的 **`deriveSidebarNavigation`** 一条龙派生（含只读子会话过滤与项目表同源）→ 分发 props，240↔0 push 过渡 + 收起时 `inert`）/ **SidebarHeader**（只有搜索框——v9 顶栏常驻，不再需要「顶栏关掉时补拖拽带 + ＋」）/ **SidebarGroup**（日常与各项目共用的分组骨架：分组行 + 可折叠会话列表 + 空态）/ **ProjectRow**（图标表达展开态：项目 = folder ↔ folder-open、日常 = 恒咖啡 + 行末 hover 箭头；hover 出 «⋯»（锚在**指针点**）、置顶标记、移除项目二次确认）/ **SessionRow**（无头像文字 + 行尾状态点 + 右键菜单锚点；行上带 `data-session-id` / `data-session-active` 只读属性供 CDP 验收定位与判定，不影响视觉）/ **SessionMenu**（会话行右键三层状态机：菜单 → 改名气泡 → 删除确认；只读子会话不弹菜单）/ **ProjectSection**（「项目」小标：**v7 起固定标题不可折叠** + 常显「＋」）/ **SidebarFooter**（设置；顶栏关闭时补「本轮改动」）/ **ProjectMenu**（项目 «⋯» 菜单项 builder）/ `useExpandedGroups`（展开态读写：起点由 `expandedGroupsTouched` 决定；写入时 store 同一次 set + 单个补丁置 touched） |
| `ui/` | Button（ghost/primary × sm/md × danger）/ Dropdown / Switch（统一受控开关，支持 indeterminate）/ **Tooltip**（自定义悬浮提示，新增提示一律用它不用原生 title；右缘元素传 `align="end"` 防幻影横向滚动条）/ **ContextMenu**（通用右键菜单：portal 到 body + `place-menu` 纯函数定位，点外/Esc/选中/滚动关闭；有边框卡片外观（`rounded-xl border border-border bg-surface shadow-pop`），项高 30px、支持 `danger` 红项与 `separatorBefore` 分隔线，不再有 veil 变体；会话胶囊 / 文件行 / 左栏会话行共用，文件行三项菜单见 **FilePathMenu**）/ `place-menu`（`placeMenu` 定位 + `anchorOfElement` 锚点转换，纯函数有测试；**左栏项目 «⋯» 与右键菜单一律传指针锚点** `{ left: clientX, top: clientY, width: 0, height: 0 }` —— 传元素矩形会把高度多算一遍，菜单掉到行下方）/ **ConfirmDialog**（破坏性操作二次确认：极淡蒙层 `bg-ink/6` + 392px 细边框卡片 + Portal 到 body 且 `z-[60]` 压过右键菜单；点卡片外/Esc/✕ = 取消，文案与按钮由调用方给；`autoFocusConfirm` 把默认焦点给确认按钮（不传则是键盘 Enter 不确认）；非破坏性场景别默默加上）/ **QuitConfirmDialog**（Windows 退出前确认，文案走 i18n `quitConfirm.*`，并回 `app:quitDialogShown` 上屏回执） |
| `icons/` | 内联 SVG 集中管理；`icons.test.ts` 校验所有 path `d` 语法（防残缺数据被 Chromium 丢弃） |

## 「想改 X 改哪里」速查

| 想改什么 | 改哪 |
|---|---|
| 关窗 / 退出行为（mac 隐藏、Win 退出前确认） | `main/window.ts`（`close` 分支：darwin `hide()`、win32 拦下 + 等 `app:quitDialogShown` 回执，**1.5s 无回执 = 渲染进程卡死 → 放行退出**）+ `main/index.ts`（`before-quit` 置 `markQuitting` 放行程序化退出）；renderer `stores/app-quit.ts`（挂载时置 guard + 订阅事件）+ `components/ui/QuitConfirmDialog.tsx`（挂在 AppErrorBoundary **外面**）；设计稿 `.local/design/ux/quit-confirm/` |
| 开屏动画（粒子光团 → 散场） | `renderer/src/styles/splash.css`（全部视觉与编排）+ `splash-dom.ts`（DOM/粒子参数）+ `splash.ts`（时长/单次标记）；首帧主题链 = bootstrap-theme.ts + window.ts + main/index.ts（`?theme=` 传参） |
| 消息气泡 / 代码块 / mermaid 图 / 高亮 | `components/chat/`（Markdown 样式覆写在 globals.css `.markdown-body`；mermaid 卡在 `chat/MermaidBlock.tsx` + globals.css 末尾两段 `mermaid` 段） |
| 首页大字 logo（手稿构造字标） | `chat/WordmarkConstruct.tsx`（空心描边 + 制图构造线静态 SVG，canvas 度量字形墨盒后离线固化；改设计重新烘焙）+ globals.css `--lg-ol/c1/c2/lb`（深浅各一套）；设计稿 `.local/design/pi-logo/wordmark.html`（H2 手稿构造） |
| APP / LAN 图标 | SVG 母版 `packages/desktop/build/icon.svg` → 桌面打包入口 `build/icon.png`（1024px RGBA）；LAN/PWA 同图缩至 512px、pngquant 后内联在 `main/lan-icon.ts`；方向稿 `.local/design/pi-logo/index.html` |
| README 顶部横幅 | 正式浅/深 SVG：`docs/assets/img/readme-hero-{light,dark}.svg`，`README.md` / `README.zh.md` 用 `<picture>` 随系统主题切换；生成器 `.local/design/readme-header-v2/build.mjs` 直接读取空白页 `WordmarkConstruct.tsx` 的同一份字标 SVG |
| 报错卡 / 错误分类 | `chat/ErrorNote.tsx` + globals.css（`.error-note*`/`.retry-note`/`.send-error`/`.toast` 段）+ `shared/src/errors.ts`（classifyLlmError 模式表 + 信封构造）+ i18n `error.*`；severity 色改 `--color-err/warn/info`（深浅各一份） |
| 工作中预览行 / 状态动画 | `chat/PreviewTicker.tsx` + `activity-ticker.ts`（minDwellMs 350）+ `MetaGroup.tsx`（状态行 orb + liveItems）+ `use-sweep-highlight.ts`（统一扫光）+ `use-shown-working.ts`（1500ms 滞后缓冲）+ `CenterOrb.tsx`/`center-orb-draw.ts`（中央版，开关 ui-preferences）+ shared `transcript/meta-summary.ts`（圆点行/统计行） |
| 输入框 / 发送 / 停止 / 排队 | `composer/Composer.tsx`（装配层）+ `use-composer-send.ts`（发送/停止/取回排队）；草稿持久在 `stores/drafts.ts`；排队事件 `queue_update` + getFollowUpMessages |
| 模型快速切换 | `composer/ModelPicker.tsx`（弹层 `absolute right-0 bottom-full w-72`：**必须右对齐**——模型按钮在 composer 右侧，向左展开才不出视口；`left-0` 会越界并因搜索框 autoFocus 触发 `#root` 程序性横滚，见 PITFALLS）+ `stores/sessions.ts`（models/currentModel/setCurrentModel） |
| 思考深度切换 | `composer/ThinkingPicker.tsx` + `stores/sessions.ts` + shared `src/thinking.ts`（档位常量单一事实源）+ `lib/thinking.ts`（clamp 共用；后端 SDK 内再 clamp 兜底） |
| 图片附件（选图/粘贴/预览/门控） | `composer/Composer.tsx`（images state + Ctrl+V + imageInput 门控 fail-open）+ `chat/MessageItem.tsx`（历史缩略图）+ `chat/ImagePreview.tsx`（全屏预览三处共用）；事件流提取在 shared reducer，历史回放在 backend `toSessionMessages` |
| show_image 发图 | 工具本体 `backend/src/tools/show-image.ts`；实时 = shared reducer（pendingImages 缓冲，turn_end 固化排 assistant 之后）；历史 = `toSessionMessages` 的 `role:"image"`；渲染 = MessageItem image 分支（缩略图按数量分档） |
| subagent 独立行 | 工具 `backend/src/tools/subagent/`；提取 shared `src/subagent.ts`（extractSubagentRuns，结构检测不依赖工具名）；互斥通知 `subagent_mutex` → reducer system 消息（dedup by extensionPath）；渲染 `chat/SubagentRunCard.tsx`（行内 11px ink-faint 展示实际思考档位；有 `sessionFile` 的行可点 → `openFromHistory` 打开**只读**检视页）。**检视会话只从导航投影过滤**（`lib/session-visibility.ts`）：它留在 store `sessions` 里，但不进左栏分组/计数/搜索与顶栏胶囊 |
| 斜杠命令 | 面板 `composer/SlashMenu.tsx` + `slash-filter.ts` + `use-slash-menu.ts`；命令表 backend `slash-commands.ts`（**新会话页（无 active）按 `cwd` 走 `listSlashCommandsForCwd`，真实会话按 `sessionId`**）；**模板/skill/扩展命令 SDK 原生展开无需代码**；`/settings` 定位走 settings store `openWith()` |
| 上下文压缩 UI | compaction_start/end → shared reducer 生成 system 消息 + compacting 位（**压缩期间 Composer 禁发**，SDK 拒绝压缩中的 prompt）；渲染 `chat/SystemMessage.tsx`（分割线，done 可展开摘要）；手动 `/compact [focus]`（focus 拼入摘要 prompt）；**压缩后 UI 历史完整保留**（SDK 只裁 LLM 上下文，jsonl 完整，reducer 只追加分界线） |
| 上下文蒸发 | backend `tools/context-evaporation/`（见 backend 表）；开关 = 设置 GeneralPanel 二态（默认蒸发，写 settings.json 单 key，2s 生效免重开）；调参 `scripts/replay-evaporation.mts`；观测 = log `context-evaporation` 行 + trace_custom |
| 上下文用量圆环 | `composer/ContextRing.tsx` + `hooks/use-context-usage.ts`（事件驱动刷新，与插件 host API 共用）→ IPC getContextUsage → SDK `session.getContextUsage()`（percent null 或无消息不渲染；<60% 灰 / 60-85% 琥珀 / >85% 红） |
| 每轮计时行 + 文件变更 chip + diff 侧栏 | 计时 shared `transcript/turn-timings.ts`（deriveTurnTimings；分量 = reducer 盖戳的 `UIToolCall.endedAt` + `runEndedAt` 定格 + 历史回放透传 toolResult timestamp）；变更 shared `transcript/turn-files.ts`（deriveTurnChanges）+ `chat-rows.ts`（行定位：每轮必有计时行，lan-web 不传 timings 保持旧行为）；渲染 `chat/TurnDiffChip.tsx`（timer 恒在首位）+ `diff/DiffSidebar.tsx`（含 BranchRow）；开关 = SessionTabBar 的 DiffIcon 按钮 + `stores/ui.ts` diffSidebarOpen |
| 顶栏 tab / 拖拽排序 / 置顶 | `session/SessionTabBar.tsx`（dnd-kit，DragOverlay ghost 拾起时实测宽度沿用原胶囊 + 轴锁定 + drag-region 退出）+ `stores/sessions.ts` `selectBarSessions`（**顶栏严格 = 置顶表**：会话被置顶就算 tab 没开也在顶栏，点击自动开；新会话不进顶栏）+ `stores/ui-preferences.ts` `reorderPinned`（拖拽改 `pinnedSessions` 顺序） |
| 左侧栏（分组 / 开合 / 置顶 / 搜索 / 移除项目 / 会话右键菜单） | 组件 `components/sidebar/*`（容器 → `Sidebar`；纯派生 → `lib/sidebar-groups.ts`，有单测）+ 持久化字段 `barSessionsVisible` / `sidebarCollapsed` / `expandedGroups` + `expandedGroupsTouched` / `pinnedProjects`（`ui-preferences.ts` → main `ui-state.ts` normalize + 旧文件缺字段时的 touched 迁移）+ 宽度过渡与状态点呼吸 `styles/globals.css` 的 `.sidebar*` 段；置顶会话的行首图钉在 `sidebar/SessionRow.tsx`（行首 16×16 图标槽，标题 x 恒 38）；逐帧截图 `scripts/shoot-sidebar.mjs` |
| 顶栏内容 / 显隐 | 顶栏**常驻**（窗口拖动、左栏开合、变更侧栏入口都在上面，v9 起不再整条隐藏）→ `App.tsx` 无条件渲染 `SessionTabBar`；设置项「顶栏显示会话」（`settings/AppearancePanel.tsx` → `barSessionsVisible`）只控制**要不要出置顶会话胶囊**：关掉后顶栏不出胶囊、也不出空态提示，会话全在左栏（v9 已删旧版的三处兜底：左栏头 44px 拖拽带 + 「＋」、聊天列顶 12px 隐形拖拽带、左栏底部「本轮改动」入口） |
| 右侧变更浮层 | `components/diff/DiffSidebar.tsx` + `globals.css` 的 `.diff-sidebar`（固定 `min(420px, 38vw)`，transform 进退，不压缩聊天列）；开关在顶栏（顶栏关闭时在左栏底部），关闭入口 = 开关 / 面板关闭按钮 / Esc |
| 权限审批面板 | `backend/src/permissions/gate.ts`（队列）+ `session/ApprovalDock.tsx`（快捷键 Enter/A/D/Esc；await 成功才移除） |
| 扩展交互（issue #45） | 契约 `shared/src/extension-dialog.ts` → `backend/src/session/extension-dialog-host.ts`（队列+裁决）→ `main/ipc/` 转发 → `stores/transcript.ts` pendingDialogs → `session/InteractionDock.tsx`；notify→`stores/toasts.ts` pushExtension；setEditorText→草稿+预填提示（Composer） |
| 会话权限模式（默认/完全访问） | 后端：`pi-backend.ts`（`permissionModes` map 内存态 + `get/setSessionPermissionMode`）+ `permissions/extension.ts`（fullAccess 审计分支）+ `permissions/audit.ts`；IPC：`PermissionGetMode/SetMode`；前端：`composer/PermissionPicker.tsx`（chip；新会话页读写 `newSessionDraft.permissionMode`）+ `stores/sessions.ts`（真实会话走 `permissionModes` map，promotion 成功后把 draft 档位应用到新 id）+ `use-composer-send.ts`。**模式不写进 permissions.json、不被新会话继承（spec D1）；D7：按会话持久化到 ui-state.json 的 sessionPermissionModes（只存非 default，切回默认即删键），打开会话时 await 恢复——重启/内存回收后重开同一会话保住原档位，新会话与 fork 仍从 default 起步** |
| 逐工具权限规则 | `backend/src/permissions/`（求值链在 extension.ts：deny → 临时区 → 多根边界读写分离 → 项目记忆 → ask）+ `project/workspace-store.ts`；enabled=false 只能手改 permissions.json（UI 无入口的逃生舱）；设置页工作区根管理 UI 未实现，手改 workspaces.json |
| 项目信任 | backend `project/trust.ts` + `trust-loader.ts`；触发点 `stores/sessions.ts`（activateNewSessionDraft/setDraftCwd）与 `stores/projects.ts`（addProject）；弹窗 `session/TrustDialog.tsx` |
| 日常空间（非项目闲聊维度） | main `daily.ts`（目录）+ IPC `app:getDailyDir` → renderer `lib/daily.ts`（缓存/判定）；侧栏钉顶分组 `components/sidebar/*`（`lib/sidebar-groups.ts` 里 `isDailyCwd` 的会话归「日常」组，label 取 i18n `projects.daily`）；隔离 = `stores/projects.ts` deriveProjects 过滤 + deleteProject 守卫（有 projects.test.ts）；空态 chip `session/ProjectBranchPicker.tsx`（下拉钉顶「日常」项，新会话页可在 日常 ↔ 项目 双向切换）；胶囊咖啡头像 `SessionTabBar.tsx`（余态白底黑字，状态色优先）；设计稿 `.local/design/ux/daily-space/` |
| 会话分叉 / 撤回 | backend `forkSession`/`recallMessage`（目标解析在 session/messages.ts；**agent 运行或压缩期间均拒绝**）；renderer `stores/sessions.ts`（fork 新 tab 打开并返回新 sessionId；recall 草稿回填 + COMPOSER_FOCUS_EVENT）+ `chat/message-actions.tsx`（ForkButton 挂轮次末段正文/RecallButton 挂用户气泡，运行/压缩期间禁用） |
| 对话区选中引用 / 引用胶囊 | 弹出菜单 `chat/SelectionToolbar.tsx`（selectionchange 缓存 + mouseup 显示；菜单 onMouseDown preventDefault 保选区；readOnly 不弹，busy 禁 fork）→ 草稿 `quotes: string[]`；胶囊 `composer/QuoteChip.tsx`；发送拼接 `composer/quote.ts`（buildQuoteBlock 置最前 blockquote）；「新会话继续」= forkSession 末条 assistant（entryId 优先/sourceText 兑底）→ 写新会话页输入区（`__new__` 草稿） |
| 长会话渲染性能（切会话卡顿 / 首屏挂载量） | 窗口策略 `chat/mount-window.ts`（纯函数 + 测试；常量在 `chat/MessageList.tsx`）；**补挂的视口锚定交给浏览器滚动锚定**（容器 `overflow-anchor` 保持默认，别加 `none`），手写补偿只兜底 `scrollTop === 0` 时浏览器不锚定的情况（按旧首行视口位置漂移补差）；工具卡溢出测量调度器在 `chat/ToolCallCard.tsx`（共享测量队列 + 共享 ResizeObserver）。背景与实测数字见 PITFALLS「长会话切会话卡顿」（含 0.5.7 上滑被拽回底部那次二次修复） |
| todo 面板 + compaction 恢复 | 工具 `tools/todo.ts` + 恢复注入 `tools/todo-reminder.ts` + 读取 `getTodos`；UI `chat/TodoPanel.tsx` + `stores/ui.ts` todoExpanded；reducer 提取 `tool_execution_end`；打开会话恢复 = loadSessionBundle 后 loadTodos |
| 会话自动命名 | `backend/src/session/naming.ts`；手动重命名 = 胶囊右键 → `session:setName`（活跃会话走 SDK `setSessionName` 发事件；历史会话离线写文件见 `backend/src/session/rename.ts`）+ `session/RenamePopover.tsx` |
| 会话置顶（本地偏好，不写会话文件） | `ui-preferences.ts`（`pinnedSessions` → ui-state.json）→ 顶栏分区 `partitionSessionsByPin` + 项目页 `groupSessions`；删除会话时在 `stores/projects.ts deleteSession` 里 unpin；动作（含顺带重排）在 `session/session-menu.tsx`（顶栏与悬浮面板共用） |
| 文件路径右键（打开 / 在访达显示 / 复制路径） | 主进程解析 `main/path-target.ts` + IPC `app:resolvePath`/`openPath`/`revealPath`（`ipc/app.ts`）；UI `ui/FilePathMenu.tsx`，挂点 = `chat/TurnDiffChip.tsx` 文件行与 `diff/DiffFileCard.tsx` 卡片头 |
| webfetch 工具 | `backend/src/tools/webfetch/`（SSRF 在 ip-guard.ts；截断/超时/重定向参数在 tool.ts） |
| 社区包目录（浏览/安装/卸载） | backend `packages/catalog.ts` + `admin.ts`；UI `settings/extensions/` + `stores/catalog.ts`（防抖/防陈旧/装卸态） |
| provider 设置 / 交互登录（OAuth + api_key） | backend `settings/settings.ts` + `login.ts` + shared `settings.ts`（类型）+ IPC `settings:login*`；UI `settings/providers/`（表单/登录对话框）+ `stores/provider-login.ts` + `stores/settings.ts` |
| 子代理模型/思考深度偏好 + 执行器开关 | backend `settings/model-prefs.ts`（`subagentModels`/`subagentThinking`/`subagentPreferBuiltin`，读侧白名单）+ `pi-backend.ts`（deps 注入 getter、`listSubagents` 透出 thinking/thinkingWarning）；UI `settings/providers/SubagentPanel.tsx` + `stores/settings.ts`；IPC `settings:setSubagentThinking`/`setSubagentPreferBuiltin` |
| 自动更新 | `main/updater.ts` + `update-policy.ts` + shared `update.ts`；UI `session/UpdateButton.tsx`（顶栏）+ `settings/AboutPanel.tsx`（手动检查） |
| 局域网观察页 | 契约 shared `lan.ts` → backend `lan/` → main `lan.ts` + `ipc/lan.ts` → preload → 设置 `LanObserverPanel.tsx`；浏览器页面 = `desktop/src/lan-web/`（独立 vite 单文件，`?raw` 内联） |
| 主题 / 背景图 / Markdown 代码块主题 | `stores/theme.ts` + `styles/globals.css`（双套 token）；main `background.ts` + `pi-bg://` 协议（CSP img-src 含 pi-bg:）；UI `settings/AppearancePanel.tsx`；代码块主题走 `Markdown.tsx` 的 isDark + 显式双主题 |
| Toast | `stores/toasts.ts` + globals.css `.toast` / `.toast-overflow` 样式段 |
| UI 插件（槽位/区域/面板/无头/热重载） | 运行时 `renderer/src/plugins/`（registry：headless activate/cleanup 生命周期）；构建/扫描 `main/ui-plugins/`（build/manager/config）；IPC `main/ipc/ui-plugins.ts`；类型 shared `ui-plugins.ts`；规范与内置插件 `desktop/resources/ui-plugins/`（SPEC.md / percho-ui.d.ts / skills / examples / builtin/，含 voice-alerts 语音提醒） |
| 语音提醒（任务完成/审批等待播提示音） | 内置无头插件 `resources/ui-plugins/builtin/voice-alerts/`（全局安静检测状态机 + `new Audio(dataUrl)`，激活/清理走 registry headless 生命周期；开关 = UI 插件面板的插件启用）；音频 = 插件 `src/assets/*.mp3` dataurl 内联，替换文件即热重载；主窗口 `backgroundThrottling: false`（锁屏/后台不节流提醒计时） |
| 新增 IPC 通道 | 见硬约束「四处同步」 |
| 新增设置面板分类 | 面板文件 + `settings/SettingsDialog.tsx` 的 `PANELS`（插件 settings.panel 贡献不用登记，registry 动态拼接） |
| 文案 | `i18n/zh.ts` + `en.ts` |

## 本地文档（`.local/`，不入库，会定期清理——引用可能失效）

- `.local/docs/release.md` — 打包/发版流程（CI、签名、网络备忘）
- `.local/agent-work/spec/`、`plan/` — 临时设计规范/实施计划（按目录 ls 找，不逐文件索引；清理后引用即失效）
- `.local/agent-work/channel/<主题>/` — 跨会话沟通频道（channel-watch 扩展监听，配套 skill channel-pickup/design-handoff）
- `.local/design/` — 设计稿：`ux/error-system/`（报错卡定稿，项目设计语言基准）、`ux/lan_observer/`、`ux/turn_diff/`、`components/center-status-anim/`、`icons/` 等
- `.local/docs/research/` — 外部技术资料研究笔记
- `.local/docs/INDEX-full-2026-08.md` — 本次精简前的完整版索引归档（含实现细节）
