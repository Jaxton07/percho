# Percho 项目索引

> 改动代码前读这份索引，定位「该改哪块」；改动完成后检查是否过时（文件增删、导出变化、职责变化都要同步）。
> 排查疑难问题优先看 `docs/PITFALLS.md`（症状索引 + 事故复盘）；打包发版流程见 AGENTS.md 与 `.local/docs/release.md`。
> 本文件只做**导航**：职责一句话 + 指到源码；实现细节以代码为准，坑记 PITFALLS，不在此堆积。

## 硬约束（改代码前必知）

- renderer 绝不 import pi 包，只经 `window.pi`（preload）通信
- `packages/backend/src/pi-backend.ts` 是唯一 import pi SDK 的地方（钉 0.84.3）
- 新增 IPC 四处同步：`shared/src/ipc.ts` → `desktop/src/preload/index.ts` → `main/ipc/`（按域选文件）→ backend；事件转发在 `main/ipc/index.ts`
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
| `scripts/smoke-channel-watch.mts` | channel-watch 机制冒烟 V1–V6 |
| `scripts/replay-trace.mts` | 事件 trace 离线重放（`--last` 自动找最新；排查 UI 状态问题首选） |
| `scripts/replay-evaporation.mts` | 上下文蒸发离线 replay 调参（误杀率/体积曲线；`--core` 与线上实现同构对比；默认数据指 `.local/replay-data/sessions` 副本，指向正式 `~/.pi/agent` 会直接 abort） |
| `scripts/repro-full.mjs` | 把 trace 事件序列直接注入 renderer 复现（#185/白屏类问题，手法见 PITFALLS 0.5.0） |
| `scripts/shoot-rail.mjs` | UI 动画 CDP 确定性逐帧截图模板（SessionRail 演示，换场景照抄三步：触发状态 → pause 动画钉 currentTime → captureScreenshot） |
| `scripts/cdp-eval.mjs` / `cdp-shot.mjs` / `shoot-demo-gif.mjs` | CDP 页面单次求值 / 截图 / demo gif |

依赖补丁：`patches/` + patch-package（root devDep + postinstall）。目前一处 `thinking-orbs+0.3.1.patch`（移除 IntersectionObserver+visibilitychange 门控，Win11 恢复事件丢失会冻住 rAF）。改法：手改 `node_modules/thinking-orbs/dist/index.{es.js,cjs}` 两份 → `npx patch-package thinking-orbs`；升级该包前重评补丁是否仍需要。

数据与凭证：用户数据在 `~/.pi/agent/`（sessions/*.jsonl、auth.json、models.json、trust.json、workspaces.json），与 CLI pi 共享；**dev/预览态自动隔离**到 `~/.pi/agent-dev/`（`main/dev-agent-dir.ts`，含五配置种子拷贝）。会话事件 trace 在 `sessions/<dir>/traces/trace-<sessionId>.jsonl`。应用自身数据在 Electron `userData/`：tabs.json、ui-state.json、backgrounds/（renderer 经 `pi-bg://background/<文件名>` 协议加载，main 注册）。

## packages/shared — IPC 契约层

**何时改这里**：新增/修改 IPC 通道或跨进程类型（然后按硬约束四处同步）。

| 文件 | 关键导出 | 职责 |
|---|---|---|
| `src/ipc.ts` | `IpcChannels`、`PiApi` | 通道名常量 + `window.pi` 完整类型（sessions/settings/packages/app/ui-plugins/lan/login 全域通道 + 同步属性 `platform`） |
| `src/session.ts` | `SessionMeta`、`SessionStats`、`AvailableModel`（可选 `thinkingLevels`/`imageInput`，缺省 fail-open）、`SessionEvent`、`SessionMessage`、`UiState`、`PermissionRequest`、`TrustRequest`、`LoadedResources` 等 | 会话/事件跨进程类型。`SessionEvent` = pi `AgentSessionEvent` ∪ Percho 自有 UI 事件（`subagent_mutex`/`stream_guard_tripped`，不进 trace）；`SessionMessage` union：user/assistant（均带 `entryId` 供 fork/撤回；user 专属 `skill`/`sourceText`）+ `role:"image"`（show_image 回放）+ `role:"subagent"` |
| `src/transcript/` | `reduceEvent`、`messagesToUIMessages`、`buildChatRows`、`deriveTurnChanges`、`deriveTurnTimings` | **UI 消息状态机（桌面与 lan-web 共用同一份）**：`types`（UIMessage/StreamingState 等）、`helpers`（事件载荷解析）、`reducer`（pi 事件 → UI 状态）、`mapping`（历史回放）、`parse-patch`（unified diff 结构化解析）、`turn-files`（按轮聚合文件变更）、`turn-timings`（按轮计时派生 + runEndedAt 定格）、`chat-rows`（行序列分组 + 轮末行定位规则）、`meta-summary`（工具语义分类统计） |
| `src/errors.ts` | `UiError`、`classifyLlmError`、`buildLlmUiError`、`buildStreamGuardUiError`、`DETAIL_MAX_LENGTH` | 统一报错信封：错误卡数据源（live reducer / 历史回放 mapping / Composer 内联 / LAN 共用）；`classifyLlmError` 按 401/429/context/网络模式分类，误判只影响标题措辞 |
| `src/ui-plugins.ts` | `UiPluginManifest`、`UiPluginInfo`、`UiPluginsConfig`、`KNOWN_UI_SLOTS`、`KNOWN_UI_REGIONS`、`UI_PLUGIN_ANCHORS` | UI 插件跨进程类型：manifest（slots/contributions/headless 三选一）/ 扫描合成信息 / 持久化配置 / 事件载荷；`KNOWN_*` 供 main 校验，与 renderer `plugins/slots.ts` 对齐（registry.test.ts 断言） |
| `src/lan.ts` | `LanObserverConfig`、`LanStatus`、`LanSessionBrief/View`、`LanSseFrame` | 局域网观察页跨进程/HTTP 投影契约 |
| `src/packages.ts` | `CatalogPackage*`、`NPM_NOT_FOUND_SENTINEL`、`isSubagentPackage` | pi.dev 社区包目录类型（设置页扩展面板用；`isSubagentPackage` 启发式仅供安装警示，非安全边界） |
| `src/settings.ts` | `ProviderInfo`、`CustomProviderInput`、`KNOWN_APIS`、`LoginAuthPrompt/LoginEventPayload` 等 | provider 设置类型（含订阅登录 OAuth 镜像） |
| `src/subagent.ts` | `SubagentRunData`、`extractSubagentRuns`、`isSubagentToolName` | 子代理结果提取（结构检测不依赖工具名；single/parallel/management 三形态），backend 历史映射与 renderer 共用 |
| `src/skill-invocation.ts` | `parseExpandedSkillInvocation`、`formatSkillCommand` | 成功展开的 skill 调用展示投影：严格匹配 SDK canonical producer 格式，提取安全 name/args；backend 命名/撤回与 renderer 实时映射共用 |
| `src/todo.ts` | `TodoItem`、`TODO_TOOL_NAME`、`extractTodos` | todo 工具契约（backend 注入与 renderer 面板共用） |
| `src/update.ts` | `UpdateState` | 自动更新事件载荷（`available.manual=true` = 当前构建无法自动安装，跳 release 页） |
| `src/marquee-motion.ts` | `tailOffsetForWidths` | 流式正文 tail-follow 位移纯函数（无 DOM，可单测） |

## packages/backend — pi SDK 适配层

纯 Node，不依赖 Electron。唯一 import pi SDK 的包，import 收敛在 `pi-backend.ts`。

```
src/
├── index.ts            barrel
├── pi-backend.ts       门面：会话生命周期 + 各域薄委托（desktop main 只 import 这里）
├── json-store.ts       统一 JSON 持久化原语
├── slash-commands.ts   斜杠命令清单（纯函数）
├── log.ts              结构化日志
├── lan/                局域网观察：config / projector / server（+ audit / sanitize）
├── session/            registry / naming / messages / trace+traces / event-slim+stream-guard / rates / ui-context
├── permissions/        index(barrel) / bash-chain / pattern / config / tmp-zone / gate / extension
├── project/            trust / trust-loader / workspace-store / files
├── settings/           settings / model-prefs / login
├── packages/           admin / catalog
└── tools/              show-image / todo / todo-reminder / webfetch / subagent / context-evaporation / channel-watch
```

| 文件 | 关键导出 | 职责 |
|---|---|---|
| `src/pi-backend.ts` | `PiBackend` | **门面**：create/open/close/delete/prompt（followUp 排队，preflight 回执见 `use-composer-send`）/abort/fork/recall/compact/stats/listModels（附 `thinkingLevels`/`imageInput`）/事件与权限·信任分发（respondPermission **先 gate.respond 放行再持久化**，持久化失败只 log 不挂会话）。`buildCustomTools(gate)` 注册 webfetch+show_image+todo+subagent；`buildExtensionFactories` 注册序 = context 钩子链序：权限门控 → 上下文蒸发 → channel-watch → todo-reminder（最后，注入不被折叠）；subagent 子会话 `noExtensions`。`sessions-subagents/` 下会话记 readOnly，prompt/fork/recall/setModel 一律 throw |
| `src/json-store.ts` | `JsonStore`、`JsonStoreCorruptedError` | 统一 JSON 持久化：tmp+rename 原子写；read 损坏回退默认、update 损坏抛 CorruptedError 拒写；async 版 per-path 队列串行化、sync 变体热路径用；缓存/normalize 不进本层 |
| `src/slash-commands.ts` | `BUILTIN_SLASH_COMMANDS` | 内置静态表（compact/name/export/settings）+ 模板/skill/扩展命令映射（纯函数） |
| `src/log.ts` | `createLogger`、`initLogging` | 结构化日志：按天落盘 `main-<本地日期>.log`（`PI_LOG_LEVEL`/`PI_LOG_DIR`） |
| `src/session/messages.ts` | `toSessionMessages`、`resolveRecallEntryId`、`resolveForkEntryId`、`block*` | pi 消息 → SessionMessage 解析（纯函数，可独立单测）：toolResult 回填、show_image/subagent 提取、edit `details.patch` → `SessionToolCall.diff`、entryId 配对（user·assistant 分表防同 ms 碰撞）；fork/recall 目标解析 |
| `src/session/traces.ts` + `trace.ts` | `SessionTraces`、`TraceRecorder` | trace 生命周期 / 批量落盘（500ms/128 条 flush；单事件 >512KB 截断标记、按字节轮转——加固背景见 PITFALLS 0.4.6） |
| `src/session/event-slim.ts` | `slimMessageUpdate`、`slimBulkyEvent` | 事件瘦身（emitEvent 单点）：剥流式 delta 携带的全量快照、剥 image base64/截断超长 text；details 与终态消息不动（事故背景见 PITFALLS） |
| `src/session/stream-guard.ts` | `StreamGuard` | 流式熔断（emitEvent 单点）：连续空白 >8KB 或单消息 >2MB → abort + 丢弃后续增量；双路径清理防 Map 泄漏 |
| `src/session/rates.ts` | `EventRateTracker` | 每会话事件速率统计（60s 滑窗），心跳/崩溃快照数据源；prune 防泄漏 |
| `src/session/naming.ts` | `autoNameSession` | 首条用户消息 message_start 即取首行做标题（skill 命令先还原 `/skill:name` 投影，有测试） |
| `src/session/ui-context.ts` | `makeUiContext` | `ExtensionUIContext` 桥接：confirm → PermissionGate，其余 no-op；**theme 必须是真实 `Theme` 类实例**（假对象会让 pi-mcp-adapter 等扩展 `theme.fg()` 抛错、MCP 服务器全连不上）；SDK 接口变化时在此补新成员 |
| `src/permissions/gate.ts` | `PermissionGate` | 权限确认队列：allow/deny/allowAlways/allowDir + kind/suggestDir 元数据；respond 前供 PiBackend 持久化；listPending 供 LAN 只读快照 |
| `src/permissions/index.ts`（+ bash-chain/pattern/config/tmp-zone） | `evaluateBashCommand` 等 | 逐工具权限规则引擎：allow/ask/deny × 通配模式；bash 命令链取最严段；自保护（permissions/workspaces/auth/trust 四文件）；tmp-zone = 临时区判定 + rm 豁免（纯函数）。已知天花板：xargs/find -exec/python -c 不覆盖 |
| `src/permissions/extension.ts` | `makePermissionGateExtension` | 权限门控内置扩展（tool_call 钩子 + 确认通道）。求值链：① deny 直接 block → ② 临时区 → ③ 多根边界（projectRoot ∪ workspaces roots）读写分离（读默认放行/写默认确认）→ ④ 项目记忆 allowed[] → ⑤ ask |
| `src/project/trust.ts` | `TrustGate`、`resolveProjectTrust` | 信任决策链：无资源→信任 → trust.json → defaultProjectTrust → 两选项弹窗（信任/不信任均落盘）；同 cwd 在途询问去重 |
| `src/project/trust-loader.ts` | `ProjectResourceLoader` | 两阶段资源加载：先用户级（projectTrusted:false）→ 信任决策 → 按结果重载 |
| `src/project/workspace-store.ts` | `loadWorkspaces`、`addWorkspaceRoot`、`addAllowedPattern` 等 | `~/.pi/agent/workspaces.json`：per-project `roots[]`（「允许此目录」写入，多根边界）+ `allowed[]`（allowAlways 模式键，LRU 200） |
| `src/project/files.ts` | — | @ 补全的文件列表（walk 排除 node_modules/.git/dist 等，5000 上限 30s TTL） |
| `src/tools/webfetch/` | `makeWebFetchTool` | 内置 webfetch 三模块：`ip-guard.ts`（SSRF 防护，独立成文件便于审计）/ `html-to-text.ts` / `tool.ts`（抓取循环+截断+github blob 重写） |
| `src/tools/show-image.ts` | `makeShowImageTool` | 内置 show_image：`paths` 数组 1-9 张/次；图片只走 `details`（模型不可见、jsonl 自动持久化），`content` 只回一句文本；路径规整 ~ 展开 + unicode 空格归一 |
| `src/tools/todo.ts` + `todo-reminder.ts` | `makeTodoTool`、`makeTodoReminderExtension` | todo 工具（全量替换协议，`details.todos` 供 UI）+ 恢复扩展（context 钩子注入 `customType:"todo-reminder"`——用 context 而非 before_agent_start：overflow willRetry 同 run 重试也覆盖） |
| `src/tools/subagent/` | `makeSubagentTool`、`runSubagent`、`applySubagentMutex`、`discoverAgents` | 内置进程内 subagent：single `{agent,task}` + parallel `{tasks[]}` cap 8/并发 4；子代理 = 共享 modelRuntime 的隔离 `AgentSession`（资源最小化 + 权限桥父 gate，完成等 `agent_settled`）；会话文件落 `sessions-subagents/`（打开即只读）；**参数 schema 必须拍平单 object**（DeepSeek 对顶层无 `type:"object"` 直接 400，严禁顶层 Union/Intersect）；互斥 = 同名覆盖 + `subagent_*` 家族停用（发 `subagent_mutex` 事件）；runner 转发子会话原生事件（检视页实时收流）；agent 定义：内置 scout → user `~/.pi/agent/agents/` → project `.pi/agents/`（仅 trusted） |
| `src/tools/context-evaporation/` | `makeEvapExtension`、`readContextManagerMode`、`writeContextManagerMode` | 内置上下文蒸发扩展（**默认开启**，二态蒸发/off）：context 钩子把到龄工具输出按四级水位线蒸发为 stub（零 LLM、决策单调持久化保 KV cache）；核心三文件（types/estimate/evaporate）零 SDK/零仓库 import（replay `--core` 同构验证）；二态配置单 key 单一写者（写侧顺带清遗留键）；调参走 `scripts/replay-evaporation.mts`；批次观测 = log + trace_custom 行 |
| `src/tools/channel-watch/` | `makeChannelWatchExtension` | 内置跨会话频道协作扩展（默认开）：订阅 `.local/agent-work/channel/<topic>/`，**消息 = 意图：写文件 ≠ 通知，channel_post 工具才唤醒**（根治一次任务写 N 文件 = N 唤醒）；防环三层（自写窗口 + hash 去重 + 乒乓上限暂停）；`closed:true` 终态退订；分模块 config/init/guard/watcher/subscriptions/post/tools/extension；配套 skill channel-pickup/design-handoff |
| `src/settings/settings.ts` | `SettingsService` | provider/模型/凭证读写（key 走环境变量引用，绝不落明文）。listProviders 默认本地 refresh（`allowNetwork:false`），显式 forceNetwork 才联网；custom provider 增改走 `buildCustomEntry`（未设字段不落盘）；模型列表留空 = 覆写 baseUrl 共享官方列表；`setProviderBaseUrl` = 内置 provider 端点覆写专用；移除凭证走 `runtime.logout()`（直接删文件残留内存态） |
| `src/settings/model-prefs.ts` | `ModelPrefsService` | `model-prefs.json`：隐藏模型 + 停用 provider + per-agent 子代理模型；`listModels()` 唯一出口过滤 |
| `src/settings/login.ts` | `LoginService` | provider OAuth 登录桥接：AuthInteraction → IPC 事件（prompt 挂起等 renderer 应答；浏览器先到则拒挂起 prompt） |
| `src/packages/admin.ts` | `PackageAdmin` | 社区包搜索/安装/卸载/已配置清单 + 装卸后对非流式会话热重载（对齐 CLI /reload）；npm ENOENT 转带哨兵的可读错误 |
| `src/packages/catalog.ts` | `fetchPackageCatalog` | pi.dev 目录抓取：无 JSON API，解析 SSR HTML 的 `<article data-package-card>` |
| `src/lan/` | `LanObserverServer`、`seedView`/`applyEvent` | 局域网只读观察：userData 配置 + token 轮换、纯会话投影、GET-only HTTP+SSE（timingSafeEqual、5 客户端上限、合帧） |

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
| `src/main/ipc/index.ts` | `registerIpc` 组合入口 + backend 事件/updater 状态转发 + UI 插件热重载 watcher 启动。**新增 handler 改对应域文件，不在 index.ts 堆** |
| `src/main/ipc/{sessions,settings,packages,app,ui-plugins,lan}.ts` | 各域 handler（全部薄委托 backend；ui-plugins 域 handler async await 落盘后才返回） |
| `src/main/tabs.ts` / `ui-state.ts` | tabs.json / ui-state.json 读写（JsonStore 原子写；ui-state 补丁式合并 + normalize 补缺省） |
| `src/main/background.ts` | 背景图选图（dialog → 拷贝 `userData/backgrounds/` 并清理旧图） |
| `src/main/window.ts` | BrowserWindow：sandbox + preload；启动底色跟随主题防白闪（已解析主题经 `?theme=` query 传 renderer）；窗口框架按平台分流（mac hiddenInset / Win frameless+titleBarOverlay / Linux 原生）；导出 `resolveTheme`/`applyChromeTheme` |
| `src/main/ui-plugins/config.ts` | `ui-plugins.json` 读写（normalize 白名单；assignments 指向失效插件保留） |
| `src/main/ui-plugins/build.ts` | 插件 esbuild 构建器：`loadEsbuild` 懒加载 + `ESBUILD_BINARY_PATH` 指向 asar.unpacked 真实二进制（打包态坑，升级 esbuild 前重评）；react 系四个 specifier 重写到 `window.PerchoUI` shim（**与 renderer host-api.ts、resources/percho-ui.d.ts 逐名一致**）；图片/音频资产 dataurl 内联（CSP img-src / media-src 均放行 data:） |
| `src/main/ui-plugins/manager.ts` | UiPluginManager：scanAll（manifest 校验 + 单插件 try 不阻断启动）/ ensureBuilt / fs.watch 300ms 防抖热重载 / seedBuiltinPlugins（resources builtin/ → 用户目录，版本戳幂等）/ seedDocs（SPEC.md + symlink `~/.percho/ui-plugins`）/ filterContributions（校验 region/anchor） |
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
| `lib/thinking.ts` | `THINKING_LEVELS` 档位表 + `clampThinkingLevel` 就近向上收敛（语义对齐 SDK） |
| `lib/daily.ts` | 日常空间目录 renderer 缓存：`initDailyDir`（App 启动调一次，幂等）+ `isDailyCwd` 同步判定 + `setDailyDirForTest`；各处共享，不散落路径字符串 |
| `stores/sessions.ts` | 会话列表/当前会话/cwd/模型。draft 会话（`draft:` 前缀，空 tab 重启消失；发首条消息 `ensureSession` 用 draft cwd 原地转正）；信任前置 ensureProjectTrust（trustVersion 触发重拉）；打开/fork/撤回/restoreTabs 统一 `loadSessionBundle` 三件套（history→queue→todos）；拖拽排序 `reorderSessions` 落 tabs.json |
| `stores/transcript.ts` | re-export shared reducer + per-session 字段（agentActive/unseenCompletion/todos）；reducer 细节见 shared `src/transcript/` |
| `stores/event-conflator.ts` | 流式事件合流：纯追加型 delta 按会话/类型拼接 + rAF 每帧最多一次 flush，其余事件边界透传保序（可注入调度器，有测试） |
| `stores/drafts.ts` | 草稿（文本/图片/slash 胶囊/@ 引用 attachments/选中引用 quotes）按会话持久 + `COMPOSER_FOCUS_EVENT`（撤回回填后聚焦输入框） |
| `stores/settings.ts` / `catalog.ts` / `provider-login.ts` | 设置域（providers + 权限门控/上下文管理/channel-watch 开关，乐观更新回滚）/ 社区包目录（300ms 防抖 + seq 防陈旧）/ OAuth 登录状态机（**取消时机 = LoginDialog 卸载 cleanup**；先订阅事件再 invoke） |
| `stores/projects.ts` / `theme.ts` / `ui.ts` / `ui-preferences.ts` / `update.ts` / `ui-plugins.ts` / `toasts.ts` | 项目页（手动添加的按时间倒排）/ 主题与背景（init 在 render 前 await 防闪烁）/ todo 面板展开 + diff 侧栏开关（内存态）/ 会话轨道 + 中央动画开关（持久化 ui-state）/ 更新态 / UI 插件面板 / 全局 Toast（顶栏右侧，非阻塞自动消失） |
| `hooks/` | `use-context-usage`（上下文用量，事件驱动刷新）/ `use-language` / `use-session-state`（useSessionReadOnly/useSessionBusy 收敛）/ `use-session-event-bridge`（App 事件桥装配层专用） |
| `plugins/` | UI 插件运行时：`slots.ts`（槽位名+props 契约单一来源）/ `registry.ts`（zustand：overrides + contributions 堆叠 + headless activate/cleanups + 崩溃计数/loadNonces）/ `Slot.tsx`（总开关门控 + PluginBoundary 包裹）/ `RegionHost.tsx`（区域挂载点，容器语义）/ `PluginBoundary.tsx`（class 错误边界，崩溃回退）/ `host-api.ts`（`window.PerchoUI` 挂载，main.tsx render 前 import）/ `loader.ts`（initUiPlugins/reloadAll/computeAssignedSlots） |
| `i18n/` | zh/en 字典 + `useT()`（文案改这里，双字典） |
| `styles/globals.css` | Tailwind 入口 + 主题 token（`bg-canvas/bg-surface/ink 灰阶/shadow 三档` 等；组件禁写死色值，一律语义 token）+ markdown/滚动条/动画样式段 |

### components/（按域分目录）

| 目录 | 内容 |
|---|---|
| `chat/` | **MessageList**（底部跟随 + 脱离回底；行模型 `useMemo`，轮末行定位规则在 shared chat-rows）/ **SelectionToolbar**（对话区选中文字浮出菜单：添加到对话/新会话继续）/ **MessageItem**（纯分发壳）+ `message-actions.tsx`（复制/Fork/撤回按钮）/ **UserMessage** / **SystemMessage**（compaction 分割线 + mutex 通知）/ **AssistantMessage** / **Markdown**（markstream-react 流式丝滑渲染，样式覆写在 globals.css `.markdown-body`——含流式 delta 8ms 直出覆写，见 PITFALLS）/ **ToolCallCard** / **SubagentRunCard**（独立行，有 sessionFile 可点开子会话）/ **TodoPanel**（呼吸灯 + 展开 morph 同一容器）/ **MetaGroup**（memo 折叠组 + 圆点行/分类统计行）+ `use-sweep-highlight`（统一扫光）+ `use-shown-working`（working→worked 滞后缓冲）/ **PreviewTicker** + `activity-ticker`（工作中预览行调度）/ **StreamingMarquee**（溢出 tail-follow，位移用 shared marquee-motion）/ **ImagePreview**（全屏多图，portal 到 body）/ **ErrorNote**（统一报错卡）+ **RetryNote**（自动重试瞬态行）/ **CenterOrb** + `center-orb-draw`（中央状态动画，绘制闭式函数）/ **TurnDiffChip**（轮末计时行 + 文件变更 chip；计时器运行中 1s 心跳跳动/定格）/ `meta-summary-label`（i18n 胶水） |
| `diff/` | **DiffSidebar**（右侧变更侧栏：按轮分组 unified diff + 内嵌 BranchRow git 分支行；开关在 SessionTabBar）+ DiffFileCard |
| `composer/` | **Composer**（装配层 ~330 行，键盘事件分发）+ 三 hook：`use-composer-send`（ensureSession 懒创建/followUp 排队/停止先 clearQueue/发送失败草稿回填）、`use-slash-menu`（命令拉取+胶囊回填+导航）、`use-at-completion`（@ token 探测/续钻/胶囊弹回）+ 展示件 QueueBar/ImageTray/AttachmentChip/**QuoteChip**（选中引用胶囊）/SendErrorBar + **ModelPicker** / **ThinkingPicker**（按模型 thinkingLevels 过滤+clamp）/ **SlashMenu** / **AtMenu** / **ContextRing** + 纯函数 `slash-filter`/`at-files`/`send-error`/`quote`（各有测试） |
| `session/` | **SessionTabBar** + SessionTab/TabPill（状态收拢到头像图标；dnd-kit 拖拽排序，DragOverlay ghost + 轴锁定；拖拽期间退出 drag-region）/ **SessionRail**（左侧会话轨道：细线变形胶囊 + dock 波浪；开关在设置-外观）/ **ApprovalDock**（权限审批：async respond 成功才移除面板，失败保留重试）/ **TrustDialog**（项目信任两选项）/ **UpdateButton**（顶栏更新按钮）/ `session-status`（顶栏与轨道共用的状态/标题纯逻辑） |
| `settings/` | **SettingsDialog**（PANELS 注册表；分类 = 静态 + 插件 settings.panel 贡献动态拼接）/ **GeneralPanel**（语言/权限门控/上下文管理二态/channel-watch 开关）/ **AppearancePanel**（顶部 Tab 分栏：「基础」=主题三段/背景图/轨道/中央动画，「UI 插件」= 原独立分类并入的 UiPluginsSection：总开关/插件卡/槽位指派，设计稿 .local/design/ux/appearance-ui-plugins）/ **SkillsPanel** / **McpPanel**（SDK 0.84 无 MCP，占位）/ **ExtensionsPanel** + `extensions/`（目录浏览/安装/卸载，subagent 包安装两段式确认）/ **UiPluginsSection**（挂在 AppearancePanel 的 UI 插件 Tab 下） / **LanObserverPanel** / **AboutPanel** / `providers/`（ProvidersPanel + ProviderRow 操作全图标化 / LoginDialog（OAuth 对话框）/ CustomProviderForm + ModelRowsEditor（逐模型行编辑器）/ BuiltinProviderEditForm（内置端点覆写）/ SubagentPanel（子代理模型偏好）+ `model-rows` 纯函数） |
| `projects/` | ProjectPage / SearchBar（日常选中时占位词取「日常」）/ ProjectSidebar（内置「日常」空间钉顶条目：canvas 底 + 细边框 + 咖啡 glyph，无删除钮）/ SessionPanel（新会话 = createDraftSession）/ SessionRow（hover 出诊断复制/删除）/ `date-groups` / ProjectBranchPicker（仅 draft 态渲染——真实会话项目绑死不可改；日常 draft 隐藏分支选择器，chip 显示「日常」）/ `diagnostics`（buildDiagnosticsText 纯文本） |
| `ui/` | Button（ghost/primary × sm/md × danger）/ Dropdown / Switch（统一受控开关，支持 indeterminate）/ **Tooltip**（自定义悬浮提示，新增提示一律用它不用原生 title；右缘元素传 `align="end"` 防幻影横向滚动条） |
| `icons/` | 内联 SVG 集中管理；`icons.test.ts` 校验所有 path `d` 语法（防残缺数据被 Chromium 丢弃） |

## 「想改 X 改哪里」速查

| 想改什么 | 改哪 |
|---|---|
| 开屏动画（粒子光团 → 散场） | `renderer/src/styles/splash.css`（全部视觉与编排）+ `splash-dom.ts`（DOM/粒子参数）+ `splash.ts`（时长/单次标记）；首帧主题链 = bootstrap-theme.ts + window.ts + main/index.ts（`?theme=` 传参） |
| 消息气泡 / 代码块 / 高亮 | `components/chat/`（Markdown 样式覆写在 globals.css `.markdown-body`） |
| 报错卡 / 错误分类 | `chat/ErrorNote.tsx` + globals.css（`.error-note*`/`.retry-note`/`.send-error`/`.toast` 段）+ `shared/src/errors.ts`（classifyLlmError 模式表 + 信封构造）+ i18n `error.*`；severity 色改 `--color-err/warn/info`（深浅各一份） |
| 工作中预览行 / 状态动画 | `chat/PreviewTicker.tsx` + `activity-ticker.ts`（minDwellMs 350）+ `MetaGroup.tsx`（状态行 orb + liveItems）+ `use-sweep-highlight.ts`（统一扫光）+ `use-shown-working.ts`（1500ms 滞后缓冲）+ `CenterOrb.tsx`/`center-orb-draw.ts`（中央版，开关 ui-preferences）+ shared `transcript/meta-summary.ts`（圆点行/统计行） |
| 输入框 / 发送 / 停止 / 排队 | `composer/Composer.tsx`（装配层）+ `use-composer-send.ts`（发送/停止/取回排队）；草稿持久在 `stores/drafts.ts`；排队事件 `queue_update` + getFollowUpMessages |
| 模型快速切换 | `composer/ModelPicker.tsx` + `stores/sessions.ts`（models/currentModel/setCurrentModel） |
| 思考深度切换 | `composer/ThinkingPicker.tsx` + `stores/sessions.ts` + `lib/thinking.ts`（clamp 共用；后端 SDK 内再 clamp 兜底） |
| 图片附件（选图/粘贴/预览/门控） | `composer/Composer.tsx`（images state + Ctrl+V + imageInput 门控 fail-open）+ `chat/MessageItem.tsx`（历史缩略图）+ `chat/ImagePreview.tsx`（全屏预览三处共用）；事件流提取在 shared reducer，历史回放在 backend `toSessionMessages` |
| show_image 发图 | 工具本体 `backend/src/tools/show-image.ts`；实时 = shared reducer（pendingImages 缓冲，turn_end 固化排 assistant 之后）；历史 = `toSessionMessages` 的 `role:"image"`；渲染 = MessageItem image 分支（缩略图按数量分档） |
| subagent 独立行 | 工具 `backend/src/tools/subagent/`；提取 shared `src/subagent.ts`（extractSubagentRuns，结构检测不依赖工具名）；互斥通知 `subagent_mutex` → reducer system 消息（dedup by extensionPath）；渲染 `chat/SubagentRunCard.tsx` |
| 斜杠命令 | 面板 `composer/SlashMenu.tsx` + `slash-filter.ts` + `use-slash-menu.ts`；命令表 backend `slash-commands.ts`（draft 态走 listSlashCommandsForCwd）；**模板/skill/扩展命令 SDK 原生展开无需代码**；`/settings` 定位走 settings store `openWith()` |
| 上下文压缩 UI | compaction_start/end → shared reducer 生成 system 消息 + compacting 位（**压缩期间 Composer 禁发**，SDK 拒绝压缩中的 prompt）；渲染 `chat/SystemMessage.tsx`（分割线，done 可展开摘要）；手动 `/compact [focus]`（focus 拼入摘要 prompt）；**压缩后 UI 历史完整保留**（SDK 只裁 LLM 上下文，jsonl 完整，reducer 只追加分界线） |
| 上下文蒸发 | backend `tools/context-evaporation/`（见 backend 表）；开关 = 设置 GeneralPanel 二态（默认蒸发，写 settings.json 单 key，2s 生效免重开）；调参 `scripts/replay-evaporation.mts`；观测 = log `context-evaporation` 行 + trace_custom |
| 上下文用量圆环 | `composer/ContextRing.tsx` + `hooks/use-context-usage.ts`（事件驱动刷新，与插件 host API 共用）→ IPC getContextUsage → SDK `session.getContextUsage()`（percent null 或无消息不渲染；<60% 灰 / 60-85% 琥珀 / >85% 红） |
| 每轮计时行 + 文件变更 chip + diff 侧栏 | 计时 shared `transcript/turn-timings.ts`（deriveTurnTimings；分量 = reducer 盖戳的 `UIToolCall.endedAt` + `runEndedAt` 定格 + 历史回放透传 toolResult timestamp）；变更 shared `transcript/turn-files.ts`（deriveTurnChanges）+ `chat-rows.ts`（行定位：每轮必有计时行，lan-web 不传 timings 保持旧行为）；渲染 `chat/TurnDiffChip.tsx`（timer 恒在首位）+ `diff/DiffSidebar.tsx`（含 BranchRow）；开关 = SessionTabBar 的 DiffIcon 按钮 + `stores/ui.ts` diffSidebarOpen |
| 顶栏 tab / 拖拽排序 | `session/SessionTabBar.tsx`（dnd-kit，DragOverlay ghost 拾起时实测宽度沿用原胶囊 + 轴锁定 + drag-region 退出）+ `stores/sessions.ts` reorderSessions（draft 无 sessionFile 只参与内存序） |
| 左侧会话轨道 | `session/SessionRail.tsx` + `stores/ui-preferences.ts`（开关持久化）+ `session-status.ts`（状态逻辑与顶栏共用）；逐帧截图 `scripts/shoot-rail.mjs` |
| 权限审批面板 | `backend/src/permissions/gate.ts`（队列）+ `session/ApprovalDock.tsx`（快捷键 Enter/A/D/Esc；await 成功才移除） |
| 逐工具权限规则 | `backend/src/permissions/`（求值链在 extension.ts：deny → 临时区 → 多根边界读写分离 → 项目记忆 → ask）+ `project/workspace-store.ts` + `settings/GeneralPanel.tsx`（总开关）；设置页工作区根管理 UI 未实现，手改 workspaces.json |
| 项目信任 | backend `project/trust.ts` + `trust-loader.ts`；触发点 `stores/sessions.ts`（createDraftSession/setDraftCwd）与 `stores/projects.ts`（addProject）；弹窗 `session/TrustDialog.tsx` |
| 日常空间（非项目闲聊维度） | main `daily.ts`（目录）+ IPC `app:getDailyDir` → renderer `lib/daily.ts`（缓存/判定）；侧栏钉顶条目 `projects/ProjectSidebar.tsx`（选中后 selectedCwd=dailyDir，右栏/搜索/新会话全复用）；隔离 = `stores/projects.ts` deriveProjects 过滤 + deleteProject 守卫（有 projects.test.ts）；空态 chip `ProjectBranchPicker.tsx`（下拉钉顶「日常」项，draft 日常 ↔ 项目双向切换）；胶囊/轨道咖啡头像 `SessionTabBar.tsx`/`SessionRail.tsx`（余态白底黑字，状态色优先）；设计稿 `.local/design/ux/daily-space/` |
| 会话分叉 / 撤回 | backend `forkSession`/`recallMessage`（目标解析在 session/messages.ts；**agent 运行或压缩期间均拒绝**）；renderer `stores/sessions.ts`（fork 新 tab 打开并返回新 sessionId；recall 草稿回填 + COMPOSER_FOCUS_EVENT）+ `chat/message-actions.tsx`（ForkButton 挂轮次末段正文/RecallButton 挂用户气泡，运行/压缩期间禁用） |
| 对话区选中引用 / 引用胶囊 | 弹出菜单 `chat/SelectionToolbar.tsx`（selectionchange 缓存 + mouseup 显示；菜单 onMouseDown preventDefault 保选区；readOnly 不弹，busy 禁 fork）→ 草稿 `quotes: string[]`；胶囊 `composer/QuoteChip.tsx`；发送拼接 `composer/quote.ts`（buildQuoteBlock 置最前 blockquote）；「新会话继续」= forkSession 末条 assistant（entryId 优先/sourceText 兑底）→ 写新会话 draft |
| todo 面板 + compaction 恢复 | 工具 `tools/todo.ts` + 恢复注入 `tools/todo-reminder.ts` + 读取 `getTodos`；UI `chat/TodoPanel.tsx` + `stores/ui.ts` todoExpanded；reducer 提取 `tool_execution_end`；打开会话恢复 = loadSessionBundle 后 loadTodos |
| 会话自动命名 | `backend/src/session/naming.ts` |
| webfetch 工具 | `backend/src/tools/webfetch/`（SSRF 在 ip-guard.ts；截断/超时/重定向参数在 tool.ts） |
| 社区包目录（浏览/安装/卸载） | backend `packages/catalog.ts` + `admin.ts`；UI `settings/extensions/` + `stores/catalog.ts`（防抖/防陈旧/装卸态） |
| provider 设置 / 订阅登录 | backend `settings/settings.ts` + `login.ts` + shared `settings.ts`（类型）+ IPC `settings:login*`；UI `settings/providers/`（表单/登录对话框）+ `stores/provider-login.ts` + `stores/settings.ts` |
| 子代理模型偏好 | backend `settings/model-prefs.ts`；UI `settings/providers/SubagentPanel.tsx` |
| 自动更新 | `main/updater.ts` + `update-policy.ts` + shared `update.ts`；UI `session/UpdateButton.tsx`（顶栏）+ `settings/AboutPanel.tsx`（手动检查） |
| 局域网观察页 | 契约 shared `lan.ts` → backend `lan/` → main `lan.ts` + `ipc/lan.ts` → preload → 设置 `LanObserverPanel.tsx`；浏览器页面 = `desktop/src/lan-web/`（独立 vite 单文件，`?raw` 内联） |
| 主题 / 背景图 / Markdown 代码块主题 | `stores/theme.ts` + `styles/globals.css`（双套 token）；main `background.ts` + `pi-bg://` 协议（CSP img-src 含 pi-bg:）；UI `settings/AppearancePanel.tsx`；代码块主题走 `Markdown.tsx` 的 isDark + 显式双主题 |
| Toast | `stores/toasts.ts` + globals.css `.toast` 样式段 |
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
