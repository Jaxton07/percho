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
| gh 合并报 workflow scope / fork 首 PR 合不了 | 三 · gh CLI workflow scope |
| 新增 UI 文案只显示一种语言 | 四 · i18n 双字典 |
| 凭证泄漏风险、密钥误提交 | 五 · 绝不打印/提交 API key |
| LAN 页连接僵死不重连、状态「重连中/已连接」反复跳 | 二 · SSE 心跳必须是命名事件帧 |
| LAN 对话页正文重复出现在末尾、run 结束又恢复正常 | 二 · 流式增量帧不可重放（healing 兜底差量） |
| 流式输出时整个 Markdown 区域随 token 节奏闪烁、尾部文字半透明往上爬 | 四 · markstream fade 的临时合成层（已修：组件 API 关闭 fade） |
| 代码块顶部两行无法拖选、标点偶发橙色框 | 四 · 悬浮 header 命中层 + Monaco Unicode 高亮 |
| mermaid 代码块只显示源码卡不渲染、图表挤成一行不换行 | 四 · mermaid 卡接入（optional peer dep + isStrict + 失败态静默）（2026-09-18） |
| markstream 自定节点组件传 `customComponents` prop 无效 | 四 · mermaid 卡接入 → 接入点 1（只有全局 `setCustomComponents`） |
| 公式渲染成两份文字（`E = mc²E = mc2`） | 四 · mermaid 卡接入 → 接入点 6（缺 katex CSS） |
| onDragStart 里拿不到拖拽尺寸（`active.rect.current.initial` 恒 null） | 四 · dnd-kit rect ref 填充晚于 onDragStart |
| 报错文案悬在空态页不消失、切新会话还在 | 四 · store 级 error 字段永不清理（已修：改 toast + 乐观回滚） |
| 切到长会话卡顿约 1 秒、消息多的会话越久越卡 | 四 · 长会话切会话卡顿（挂载窗口 + ToolCallCard 布局抖动）（2026-09-12 修复） |
| 已完成会话上滚滚不动、要大力滚，贴底还吸附（0.5.8 线上 bug） | 四 · 长会话切会话卡顿 → 三次修复（markstream content-visibility 600px 估值占位）（2026-09-16 修复） |
| 长会话里上滚，位置被反复重置/拽回底部（0.5.7 线上 bug） | 四 · 长会话切会话卡顿 → 二次修复（markstream 占位条缩水 + 手写滚动补偿）（2026-09-13 修复） |
| 改了 `src/main/` 但 app 行为没变（dev 不重建主进程） | 三 · electron-vite dev 主进程 watcher 不可依赖（2026-09-17） |
| 关窗后 renderer 还活着、`visibilityState` 仍是 visible；用 `window.close()` 测不出关窗拦截 | 四 · macOS 关窗 = 隐藏窗口（2026-09-17） |
| 浮层/菜单退场闪回（节点被提前卸载）、二级浮层输入框没聚焦 | 四 · 浮层退场时序与焦点接管（2026-09-17） |
| 右键菜单贴边溢出视口、滚动后浮层脱锚 | 四 · 右键菜单定位与脱锚（2026-09-17） |
| Google Vertex 填了 key 仍 401「API keys are not supported by this API」 | 二 · Vertex 只支持 ADC/服务账号（api_key 路径必败，桥接层已剔除 api-key 选项） |
| 跨会话频道里对方迟迟不查收、回复总晚一整轮（实施在改文件、review 却在跑回归） | 二 · sendUserMessage 默认 followUp = 等对方 turn 结束才投递（2026-09-17） |
| 逐帧截图全是空白/同一张陈旧图、rAF 像停摆 | 四 · 合成器空帧与「暂停动画不出新帧」（2026-09-19 补） |
| 验证脚本读出「旋转没生效」（`transform: none`）但界面明明转了 | 四 · Tailwind 4 的 `rotate-*` 走 `rotate` 属性不是 `transform`（2026-09-19） |
| 脚本里手动删了 React 的节点，随后整页「界面出现异常」（removeChild 报错） | 四 · 别手拆 React 管理的 DOM（含 portal 浮层）（2026-09-19） |
| 用渲染层 JS 堆证明「卸载会话能省内存」，结论反了 | 四 · 渲染层的大头是模块级基建，不是会话数据（2026-09-20） |
| 左栏有图钉、顶栏却没有胶囊（「置顶了但不显示」） | 四 · 顶栏内容要由置顶表驱动，别从 tabs 里筛（2026-09-19） |
| 后端日志出现 `context-evaporation` / stale ctx 报错 | 二 · 删除正在跑的会话会留 stale ctx（既有现象，2026-09-20 记录） |
| hover 才现的控件刚截完图就点不到、点击静默落空 | 四 · 鼠标事件 + `:hover` → 补「截图会清掉 hover」（2026-09-19） |
| 改完自定义 hook 后整页报「Rendered fewer hooks than expected」 | 四 · HMR 改 hook 数量会假报错（2026-09-19） |
| 清理 dev 进程后端口还占着、CDP 连上但页面全空 | 五 · `pkill -f` 杀 Electron 会留下孤儿 main（2026-09-19） |

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

### Google Vertex 只接受 ADC/服务账号认证（2026-09-05 实测）

症状：Google Vertex AI 在 UI「编辑」填 Key 后显示已配置，但请求必 401 `"API keys are not supported by this API. Expected OAuth2 access token..."`（`aiplatform.googleapis.com` 的 `PredictionService.StreamGenerateContent`），对照组 Gemini API（`google` provider）同样假 key 是 400 `"API key not valid"`——即 Gemini 端点支持 API key、Vertex 端点明确拒绝。

事实：Vertex 可用的认证 = OAuth2 类（ADC / 服务账号），需 project + location + 凭据文件，且三者当前只经 `auth.json` 的 `env` 字段（CLI `/login` 交互产生，`ModelRuntime.login(providerId, "api_key", ...)` 的 `AuthInteraction`）或进程环境变量（GUI 从 Finder 启动读不到 shell env）。

已修（2026-09-05）：`LoginService` 放宽为支持 api_key 交互登录，`login.ts` 的 `filterAuthSelectOptions` 对 `google-vertex` 剔除必败的 `api-key` 选项；ProviderRow 对 `apiKeyLogin` 标记的内置 provider 显示「登录」入口。复现/验证脚本：`scripts/verify-vertex-auth.mts`（401 事实）与 `scripts/verify-vertex-login.mts`（ADC 交互落盘→configured）。

补充坑：**「已配置」徽章 = auth.json 有条目，不等于凭证真正可用**（pi CodingAgent `getProviderAuthStatus` 的 `storedProviders` 优先判定，不 resolve；CLI 同语义）。Vertex 输错凭据文件路径时列表仍显示「已配置」，发请求才失败——引导用户用「测试」按钮真实验证。

`Model` 有 `name` 无 `label`；`model.provider` 是字符串。

### 无凭证时 `getAvailable()` 返回 `[]` —— 不能当可靠的模型列表

`runtime.getModel(provider, id)` 始终可用。

### `runtime.refresh()` 不传参时 `allowNetwork` 缺省为 true（除非 `PI_OFFLINE`）

会向 pi.dev 拉全部 provider 的远程模型目录，且 `fetchWithRetry` 无内置超时，网络不可达时一直挂（设置页曾因此永久 Loading）。`SettingsService.listProviders` 默认显式 `allowNetwork:false` 走本地，仅用户点刷新才 `forceNetwork`（`force:true` + 15s 超时兜底）。

### `createAgentSession({ tools: [...] })` 传数组 = 允许清单

数组外的工具（含扩展 `registerTool` 注册的）会被 `isAllowedTool` 整个过滤掉（sdk.js `_refreshToolRegistry`）——扩展工具要生效必须不传 tools（undefined，桌面正式路径）或把工具名列进数组；冒烟/测试脚本极易踩（ACP 冒烟 V3 曾因此假阴性：模型明说「工具列表为 none」）。

### SSE 心跳必须是命名事件帧（`: ping` 注释不触发 EventSource 任何事件）（2026-08-28）

LAN observer 最初用 SSE 注释帧 `: ping` 做心跳——注释按规范不派发任何 JS 事件，客户端 **无法感知连接是否还活着**：移动端切网/锁屏后的半开 TCP 连接会僵到内核超时（可达十几分钟），页面既不来数据也不重连。且 onerror→「重连中」无迟滞，锁屏必杀连接的移动端常态让状态药丸反复跳。

修复（`lan/server.ts` + `lan-web/store.ts`）：心跳改命名事件 `event: ping`（`LanSseFrame` 联合加 ping 变体）；客户端任意帧刷新 `lastFrameAt`，超 `PING_MS*2.5` 无帧即主动断开重连（watchdog）；onerror 延迟 3s 才显示「重连中」（期间 EventSource 自动重连大概率已成功，防闪烁）；服务端下发 `retry: 1500` 加快自动重连；重连才重拉快照，首次连接跳过双拉。

### 流式增量帧不可重放：种子含 in-flight partial + healing 兜底 = 正文重复（2026-08-28）

LAN 页重连/中途进入时，快照种子经 `messagesToUIMessages` 重建——**SDK 的 in-flight partial assistant 消息就在 `session.messages` 里**（`agent.state.messages` 实时含流式中对象），种子含 partial 正文但无流式容器；后续 `text_delta` 是增量（reducer 累积语义），无容器时整体空转 → `applyFrame` 误标 `streamHealing` → ChatView 底部渲染 `view.assistantTail` 兜底气泡 → **同一段正文两份**（消息流一份 + 底部一份），直到 run 边界摘标记 + 立即重拉快照才恢复。用户观感：「正文重放拼到末尾，新事件来了又正常」。

修复：`streamHealing` 从 boolean 升级为「种子后新到 text_delta 字节数」计数器（`store-pure.ts`），兜底气泡只渲染 `assistantTail` 尾部新增后缀（`healingTailSuffix`）——种子已含的不重复，文字持续 live；标记加 `view.agentActive` 守卫（空闲会话的陈旧帧不标记/不触发边界重拉）；重种子时清空标记。**教训**：增量语义的帧不能靠重放/重种子恢复，必须给「已应用多少」一个显式边界（seq 或字节计数）。

### `sendUserMessage` 默认 followUp = 等对方 turn 结束才投递（2026-09-17，跨会话协作踩到）

两种投递模式语义差得很远（`pi-coding-agent/dist/core/agent-session.d.ts:369-383`）：

| 模式 | 投递时机 |
|---|---|
| `followUp`（channel-watch 现行用的） | **agent 没有更多 tool call 时才送达** —— 对方一个长 turn 里完全收不到 |
| `steer` | 当前这批 tool 执行完、下一次 LLM 调用前送达（不切断正在跑的 tool） |

踩到的现象：实施会话「阶段干完 post 一条 → 接着往下干」，review 的意见只能等它 turn 结束才到，本该约束过程的提醒变成事后返工（真实案例：review 要求「每批跑双向 assignable 检查」到达时阶段已做完，只能补审计）；同时 review 在实施改文件的当口跑回归，测到中间态、结论不可信。

修复（2026-09-17，改 **skill 协议**而非代码）：跨会话协作改成**阶段门**——阶段边界 `git commit` + IMPL-NOTES + `channel_post`，然后**turn 必须结束**（不再调工具）；对方回话时实施已停手（turn 结束 → followUp 立即投递），工作区也静止（review 的回归结论可信）。见 `packages/desktop/resources/skills/channel-pickup/SKILL.md`「阶段门」节。

**教训**：想让另一个会话及时收到消息，先看它的 turn 什么时候结束——`followUp` 的送达时机由**对方**的 turn 边界决定，不由发送方决定；要「立即送达」只有 `steer`（GUI 里用户自己发的消息目前也走 followUp 排队，`pi-backend.ts:572`）。所以「让双方停在同一节奏上」比引入锁/快照沙箱便宜得多。

## 三、构建 · 打包 · 环境

### electron-vite dev 主进程 watcher 不可依赖：改 `src/main/` 后必须验产物（2026-09-17 实测）

症状：改了 `packages/desktop/src/main/` 下的文件（尝试过 `window.ts` 与新增的 `path-target.ts`），行为毫无变化——因为 `out/main/index.js` **根本没重建**（本会话早先同类型编辑又确实重建过，所以是「不可依赖」而不是「一定不工作」）。renderer 侧 HMR 正常（日志有 `hmr update`），只有主进程那一侧哑火。

诊断（两行定生死）：

```bash
grep -c "<你刚写的新字符串>" packages/desktop/out/main/index.js   # 0 = 旧产物在跑
tail -5 .local/dev-logs/dev*.log                                    # 没有 “built in” = 没重建
```

做法：要测主进程改动就 **重启 dev server**（`pkill -f "electron-vite dev" && pkill -f "MacOS/Electron ."` 再起），别把「改了没生效」误判成自己代码写错了。另：main 侧改动也会让当前 dev 进程的 IPC 通道表变旧——renderer 调新通道会报 `No handler registered`。

### preload 必须是 CJS

sandbox 下渲染进程不加载 electron-vite 默认的 ESM 产物。config 强制 `format: "cjs", entryFileNames: "index.cjs"`；`main/window.ts` 加载 `../preload/index.cjs`。

### `externalizeDepsPlugin` 会把 workspace 依赖也外部化

main config 用 `exclude: ["@percho/backend", "@percho/shared"]` 并 alias 到源码；pi SDK 保持 external。

### Node >= 22.19。npm 11 默认阻止 Electron postinstall（需 `npm approve-scripts electron`）

二进制下载走 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

### 打包两个坑

pi SDK 必须声明进 `packages/desktop/package.json` dependencies（electron-builder 只从 desktop 依赖树收集）；electron 必须钉精确版本。发版/CI 细节全在 `.local/docs/release.md`（本地文档，不入库）。

### gh CLI 合并涉及 workflow 的 PR 需要 `workflow` scope（2026-09-11 发现）

`gh pr merge --squash` 报 `refusing to allow an OAuth App to create or update workflow .github/workflows/xxx.yml without workflow scope`：gh 的 OAuth token 默认只有 `repo/gist/read:org`，而**凡 merge 会改动 `.github/workflows/` 下文件的 PR，GitHub API 一律要求 `workflow` scope**。修复：`gh auth refresh -h github.com -s workflow`（设备码流程，浏览器确认，一次性）；或网页 UI 手动合。

连带坑（首贡献者 fork PR 死锁）：fork 首次 PR 的 CI 要在 Actions 页面手动 Approve 才会跑，叠加分支保护「要求 branch up-to-date + 检查通过」→ 三者互等死锁，只能 admin 旁路（`gh pr merge --squash --admin`，同样吃上面的 scope 限制）。同步 fork 分支用 `gh pr update-branch <n>`。

## 四、Renderer / React

### 鼠标事件 + `:hover`：合成 MouseEvent 不算 hover，要用 CDP 真实鼠标（2026-09-17）

验证 hover 才出现的 UI（如文件行的「⋯」按钮）时，`el.dispatchEvent(new MouseEvent("mouseover"))` 只能触发 React 的 `onMouseEnter`，**CSS `:hover` 不生效**（`el.matches(":hover")` 仍 false），读到的 `opacity` 是 0、截图里永远看不到那个按钮。

做法：用 CDP `Input.dispatchMouseEvent({ type: "mouseMoved", x, y })` 派发真实鼠标移动（元素中心坐标，视口 CSS px），撤开时先 `Emulation.setFocusEmulationEnabled({ enabled: true })`（否则失焦/遮挡态不更新 hover）。可参考临时脚本 `.local/dev-logs/hover-check.mjs`（打印 hover 前后的 `matches(':hover')` + 计算样式并截图）。

**2026-09-19 补（左栏项目行的「⋯」实测，连踩三次才看清）**：

1. **`Page.captureScreenshot` 会把 hover 状态清掉**：截完图 `:hover` 链变空、目标元素的 `pointer-events` 回落 `none`（截图前读到的 `auto` 不再成立）。于是「hover → 截图 → 接着点它」的顺序会**静默落空**（点击落在 `pointer-events: none` 上，不报错也不生效）。
2. **对同一坐标的 `mouseMoved` 不会重算 hover**：截图后想恢复 hover，直接再发一次相同坐标无效 —— 必须**先挪开一点（如 −60px）再挪回来**。
3. `mousePressed` 与 `mouseReleased` 之间**贴太紧偶发不合成 `click`**，验证点击行为时中间留 ~70ms 更稳。

### CDP 驱动 Electron dev 应用的能力边界（2026-09-19，左栏任务实测）

这几条决定「哪些 UI 行为能用脚本验、哪些必须人工」：

- **`Browser.setWindowBounds` / `Browser.getWindowForTarget` 在 Electron 下未实现**（method not found）。想真改窗口尺寸就用页面里的 `window.resizeTo(w, h)` —— Electron 支持，`window.innerWidth` 会真的变（本任务用它验了右栏 push ↔ 浮层的 1100 / 1000 / 900 三档）。
- **CDP 注入的鼠标事件不会驱动 `-webkit-app-region: drag` 的窗口拖拽**：程序化拖不动窗口（连改造前就存在的顶栏拖拽区也拖不动），所以「无边框窗口的自定义拖拽带还能不能拖」**只能人工确认**；脚本只能验到 `getComputedStyle(el).webkitAppRegion === "drag"` 且元素尺寸非零。
- `Input.dispatchMouseEvent` 坐标是**视口 CSS px**；`Page.captureScreenshot` 的 `clip` 也是 CSS px，输出像素 = clip × DPR。

### Tailwind 4 的 `rotate-*` 走 CSS `rotate` 属性，不是 `transform`（2026-09-19）

症状：验证脚本用 `getComputedStyle(svg).transform` 判断「展开箭头有没有转 90°」，拿到 `"none"`、推断「样式没生效」——但截图里箭头明明是朝下的。

原因：Tailwind 4 的 `rotate-90` 编译成 **`rotate: 90deg`**（新式独立变换属性），`translate-*` / `scale-*` 同理，所以老的 `transform` 读写看不到它们；`transition-transform` 也会展开成 `transition: transform, translate, scale, rotate`。

做法：读 `getComputedStyle(el).rotate`（或直接断言 `transitionProperty` 含 `rotate`）。**同理**：判断元素是否位移别只看 `transform`，`translate-*` 也一样。

### 别手拆 React 管理的 DOM：`removeChild` 暴雷（含 portal 浮层）（2026-09-19）

症状：脚本里为了「关掉菜单」写了 `document.querySelector('[role="menuitem"]').parentElement.remove()`，几秒后整页被错误边界接管，报 `Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node`（Percho 界面显示「界面出现异常」），于是后续所有量值全部落空、极易当成自己刚改的代码把页面治崩了。

做法：**只走组件自己的关闭路径**（`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`、或派发 `pointerdown` 到 body 让点外关闭生效）。同理：React portal（右键菜单 / 确认弹窗 / toast）里的节点一律不手动增删；要重置页面直接 `Page.reload`。

### 删除正在跑的会话会在后端留 stale ctx 报错（2026-09-20，既有现象）

症状：对一个**正在跑 agent** 的会话执行「删除会话」，后端日志会出现 `context-evaporation` / stale ctx 一类报错。原因：`deleteSession` = `closeSession()` + 删文件，**不先 `abort()`**（内存策略那轮核实过：`PiBackend.deleteSession` → `disposeSession` + unlink，没有 abort 步骤）。后果仅限日志噪音（会话确实被删掉了），但排查别的上下文蒸发问题时会误导。

现状：**属既有行为、未修**（删除是用户明确意图，行为本身是对的；缺的是先 abort 再 dispose 这一步）。要修的话：删除路径显式 `await entry.session.abort()` 再 `disposeSession`。

### 顶栏内容 = 置顶表驱动，别从 tabs 里筛（2026-09-19）

症状：把「顶栏只显示置顶会话」实现成 `tabs.filter(s => pinned.has(s.id))` 后，用户会碰到 **左栏会话行有图钉、顶栏却没有那个胶囊**（我验收时真踩到）：只要那个会话的 tab 被叉叉关过（或本次启动没恢复它），它就不在 `tabs` 里，于是被悄悄藏掉——“置顶”看起来失效了。

做法：置顶表的 id **逐个到 `tabs` → 历史（`allSessions`）里取 meta**（tabs 优先，名称/状态更新），取不到才跳过（会话已删）；点击时 `openSession` 一条路兼容“已打开就切 / 未打开就从历史开”。同理：叉叉（关 tab）只在“确实有 tab”时才该显示，否则就是假入口。

本轮同时删掉了旧模型里“置顶顺带把会话挪到 tabs 最前”这套副作用（顶栏顺序改由 `pinnedSessions` 表达，`reorderSessions` 已无引用，一并删）。

### 渲染层 JS 堆的大头是模块级基建，不是会话数据（2026-09-20）

背景：要给「会话常驻内存」做自动卸载，先验「卸载后渲染层 JS 堆能不能降」。结论：**降不下来——但原因不在会话**。

实测（dev，开 6 个最重会话 273/266/67/66/64/64 条）：打开时堆 105MB → 6 个全卸载 + 强制 GC 后 **97–99MB**，只回收 7–9MB（8%）。逐个边际：273 条 +12MB、266 条 **+4MB**、第 4 个之后 **0~1MB**。堆快照聚合（`.local/tmp/heap-snapshot.mjs` + `aggregate-heap.mjs`）显示全卸载后堆里还剩：

- **`JSArrayBufferData` +83.7MB** —— markstream 内置 shiki/oniguruma **wasm** 堆；
- `ExternalStringData` +22MB、`array(object elements)` +12MB；
- 大量 textmate 语法对象（`CaptureRule` / `BeginEndRule` / `MatchRule` / `_RegExpSource`）与 base64 语法/sourcemap 字符串。

这些是**代码高亮 / 编辑器基建**（shiki/oniguruma + mermaid + 懒加载 monaco），首次渲染代码块/图表时加载后常驻**模块级单例**，与「开着哪些会话」无关。

教训：**别用渲染层的 `performance.memory` 判断「会话内存」的收益**——先取堆快照把「基建」与「会话数据」分开；真要量化收益，看**主进程 RSS**（本项目的 pi SDK 会话 ≈ **+31MB/会话**：8 个会话 251 → 498MB，全部 dispose 后回落 167–320MB）。

同批已知未定位项（另案）：三轮「开 6 → 全关 + 强制 GC」后堆仍缓慢上爬 ~5MB/轮，疑似 markstream 内容缓存 / React 侧残留。

### HMR 下改自定义 hook 的 hook 数量会假报错（2026-09-19）

症状：改动一个自定义 hook（如给 `useExpandedGroups` 减/加一个 `useState`）后，整页被错误边界接管，控制台报「Rendered fewer hooks than expected. This may be caused by an accidental early return statement」，栈指向**使用该 hook 的组件**（如 `Sidebar`）而不是 hook 自身。

原因：Fast Refresh 用新模块重渲染已有组件实例，hook 序号与上一次渲染对不上 —— **这是 HMR 假象，不是真 bug**（reload 一次即好）。判断依据：错误只在热更新那一刻出现、刷新后不复现。别为此改业务代码，先 reload。

### Zustand selector 必须返回稳定引用（模块级 `EMPTY_ENTRY`）

内联 `?? []` 新数组会触发 React error #185 无限渲染（与 0.5.0 事故的 effect 自激是两个不同成因，症状相同）。

### CDP 冒烟往 store 注入状态必须用完整对象形状（2026-08-29）

`cdp-eval` 里 `useSessionsStore.setState({ sessions: [ { sessionId: 'x' } ] })` 这类缺字段注入会炸渲染组件（如 `TabPill` 读 `session.name.split` → TypeError，错误边界兜住但 UI 白屏重挂）。安全手法：**不碰 sessions 列表**，只对 transcript `bySession` 做函数式合并注入完整 SessionEntry 形状（各字段齐备），测完删 key；或先存原 entry 引用、最后还原。同理不要整体覆盖 `bySession`（会抹掉真实会话，App 重载时连锁出错）。

### CDP 小区域 clip 截图偶发连续 blank，全窗截图正常（2026-09-06，permission-mode 手测）

症状：`Page.captureScreenshot` 带 `clip`（如 composer 底栏 560×95 的小区域）时偶发 4 次重试全 blank；同帧全窗无 clip 截图正常。与 AGENTS.md 已记的「偶发整帧空白」同类合成器瞬时状态，但**小 clip 更易触发且重试也救不回**。对策：能用全窗截图就全窗（事后裁）；必须要小区域时改用 DOM 计算样式断言（`getComputedStyle` 颜色/位置）代替像素级验证，别在重试上耗时。

**2026-09-19 补（左栏任务实测，找到主因与一套稳的做法）**：

- **主因是窗口被遮挡/未聚焦**：此时合成器给的是陈旧或整帧空白的表面，脚本里以 rAF 为等待条件会**永久挂住**（页面 CPU 却是 0）。开场先 `Emulation.setFocusEmulationEnabled({ enabled: true })` 就能恢复 rAF 与常规截图（本任务 12 帧逐帧 + 十几张验收截图全部零空白）。
- **动画被 `pause()` 后合成器不再产新帧**：这时 `fromSurface: true`（默认）与 `false` 拿到的分别是**同一张空白/陈旧图**，逐帧 scrub（pause + `currentTime = t`）**拿不到画面**——样式确实在变（`getComputedStyle` 每帧不同），像素却不变。另外 `fromSurface: false` 会**忽略 `clip`**（只能拿全窗）。
- **要逐帧就「按 CSS 参数复现每一步」**：读 `transition-duration / timing-function / delay` 与两端取值，按缓动函数算出该时刻的 `width / opacity / transform`，关掉过渡后写成 inline style 再截 —— 每一步都是真实 CSS 值的真实渲染，且不暂停任何动画（合成器照常出帧）。参考实现：`scripts/shoot-sidebar.mjs`（左栏 240↔0 开合，双向 24 帧）。

### markstream fade 的临时合成层 = 整个 Markdown 区域随流闪烁（2026-09-05 初修，2026-09-08 根治）

症状：流式输出时正文随 token/commit 节奏整块闪一下；慢模型频率低，快模型频率高。库机制：`fade=true` 时每次可见文本 commit 都把新增量包进 `span.text-node-stream-delta`，跑 `opacity:0→1` 动画并带 `will-change:opacity`；动画结束后再沉淀进普通文本。除了尾部直接变淡，高频创建/销毁临时合成层还会让同一文本排版区域的合成/抗锯齿观感一起跳，看起来像整个 Markdown 被重绘。

2026-09-05 初修把 `--stream-update-fade-duration` 压到 8ms，只缩短了动画，没有消除临时 span 与合成层切换，仍会按模型输出频率闪。2026-09-08 根治：桌面和 LAN 的 `Markdown` 都从组件 API 传 `fade={false}`，保留 `smoothStreaming` 的 pacing。注意这与 CSS `animation:none` 不同：`fade=false` 会让库直接走稳定文本 span 分支，不创建 fading span，也不依赖 `animationend` 沉淀。

已排除的候选（实证手法可复用）：组件 remount / 整树重渲 / 块级 fade-node 重播 / controller.reset 重播（reset 是即时全亮）。给 store 注入合成 `text_delta`，页面侧用 MutationObserver + 节点身份采样 + `animationstart` 监听验证：`.markdown-body` / `.markstream-react` 身份不变，而开启 fade 时每个 smooth commit 都启动 `markstream-react-text-node-stream-update-fade-*`。次级因素：代码块 fence 打开后先渲纯文本 fallback 再换 Monaco（空闲时约 32ms，主线程忙时更长）。

### 代码块顶部不可选 + 标点橙框（2026-09-08）

两个独立原因。顶部不可选：为保留复制按钮而把 `.code-block-header` 绝对定位到代码块顶部，header 实际高 38px，恰好覆盖 18px 行高的前两行；`:hover/:focus-within` 曾把整条 header 设为 `pointer-events:auto`，透明区域也会截获拖选。修复为 header 始终 `pointer-events:none`，仅 `.code-action-btn` 恢复 `pointer-events:auto`。

标点橙框：Monaco 默认 `unicodeHighlight` 会给全角标点、不可见字符和易混淆字符生成 `.unicode-highlight` 描边，模型输出中混入这类字符时看起来像随机残留框选。只读展示没有可执行的修复动作，桌面与 LAN 的 `Markdown.tsx` 都通过 `monacoOptions` 关闭三类 Unicode 高亮，并一并关闭同词、符号 occurrence 和括号匹配 decoration；真实拖选高亮保留。诊断时用 `elementFromPoint` 检查顶部文本命中、`.view-overlays .selected-text` 检查 Monaco 内部选区；不要用 `window.getSelection()` 判断，Monaco 选区不走浏览器 Selection API。

### mermaid 卡接入：六个接入点（2026-09-18，对话区支持 mermaid 渲染）

起点症状：对话里的 mermaid 代码块只有一张「源码卡」，无图。根因：`markstream-react` 把 mermaid 当 **optional peer dependency**（库内是 `await import("mermaid")`），没装时 Vite 会生成 `assets/__vite-optional-peer-dep_mermaid_markstream-react_false-*.js`（内容就是 `throw new Error('Could not resolve "mermaid"')`），动态 import 抛错 → 库里 catch 后 warn → 降级成源码卡。**同类**: `katex` / `@antv/infographic` / `@terrastruct/d2` 同样没装（搜 `out/renderer/assets/__vite-optional-peer-dep_*` 一眼看清哪些能力没接）。

修复：`packages/desktop` 装 `mermaid@^11.17.2`（markstream 要求 `>=11`，12.0 刚发别上）。mermaid 发布形态是 core + 每图表类型单独动态 import，Vite 会切成 mermaid.core + 一堆图表 chunk，**只在出现图表时才拉**；代价是 assets +7MB（首屏无影响）。新增 `chat/MermaidBlock.tsx` + globals.css 末尾两段 mermaid 样式。

**接入点 1 · 接管必须走全局 `setCustomComponents`**。mermaid 块在库里就是 `code_block` + language=mermaid，分发时按**语言名**在自定义组件表里查，而那张表只有全局入口：`NodeRendererProps` 上没有 `customComponents`（写了 TS 报 "Property 'customComponents' does not exist"），也不读 `streamingComponents`。正解：`setCustomComponents({ mermaid: MermaidBlock })`（模块级注册一次，会 bump revision，已挂载的渲染器自动重渲）。自定组件收到的是 `{node, isDark, ...mermaidProps}`——**没有 `loading` prop**，流式判定得读 `node.loading`。

**接入点 2 · `isStrict` 默认 true，会把 `<br/>` 吃掉**。库默认 `isStrict: true` → mermaid `flowchart.htmlLabels:false` → 节点标签走纯 SVG text 路径，`<br/>` 被丢弃：多行标签挤成一行并溢出框（一开始还以为是 mermaid 不支持未加引号的 `<br/>`，实测加不加引号都能换行，真正的开关是这里）。传 `isStrict: false`（loose）即修复换行；安全性不牺牲：库插入前会过 `stream-markdown-parser` 的 `scrubSvgElement`/`toSafeSvgElement`，它把 foreignObject 拍平成 `<text>+<tspan>`（实测渲染后 foreignObject 计数为 0），HTML 标签不会进 DOM。

**接入点 3 · parse 失败是完全静默的**。库的链路是「先 parse 校验，过不了就放弃」（`Ie` 里 catch 后只尝试 prefix 渲染），`mermaid-error` 那栏只在 **render 阶段**抛错时才有，parse 失败连错误文本都不写 → 界面上剩一个空白框（`data-markstream-mode` 永远停在 `pending`）。修法：在包装组件里自己 `await import("mermaid")` 再 `parse` 一遍（**必须动态 import**，静态 import 会把 mermaid 拉进主 bundle），失败就换 Percho 报错卡（复用 `.error-note*` + `.drawer-details`，内容 = 渲染失败 + 可展开源码 + 复制）。两个坑：① 源码要先按库的规则归一化（`]::x`→`]:::`、`:::subgraphNode`→`::subgraphNode`），否则会把库能渲染的图误判成失败；② 库不可用时（LAN 版把 mermaid alias 成空 stub）`parse` 不是函数，**不要判失败**，交给库自己降级成源码卡。另用 `onRenderError` 收 render 阶段失败（返回 `true` = 已接管，库不再画自己的错误行）。流式保护：`node.loading` 为真时不做校验，且校验带 400ms 防抖、源码一变就清旧失败态。

**接入点 4 · 高度是估算写死的 inline style**。库给预览区写 `style="height: 450px; max-height: 500px"` + `min-h-[360px]`（用 `estimatedPreviewHeightPx` 估），实测它跟真实 svg 高度差很多（450 vs 243、500 vs 345）：图小留一大片空白、图高直接被 `overflow:hidden` 裁掉。修法（两层，缺一不可）：

1. `.markdown-body .md-mermaid .mermaid-block div:has(> [data-mermaid-wrapper])` 上 `height:auto/min-height:0/max-height:min(620px,70vh)` + `!important`（压 inline style）；
2. `[data-mermaid-wrapper]{position:static}` —— 库把 wrapper 定成 `absolute inset-0`，不改成文档流就永远撑不开容器。顺手 `pointer-events:none`：缩放/拖拽关掉后（`showZoomControls:false`）剩下的拖拽是僵尸交互（能把图拖出可视区且无重置）。

全屏弹层里是同一套结构（`.mermaid-modal-content`，portal 到 body，选择器**不能**挂 `.markdown-body`），实测不进同样的覆盖会看到 svg 374px 被截在 360px 容器里。

**接入点 5 · 工具栏与文案**。header 里装着全部按钮，`showHeader:false` 会连复制一起消失；所以样式上做悬浮（`position:absolute` + `opacity:0`，`:hover/:focus-within` 才显形；`> div:first-child` 是图标+Mermaid 标签，隐藏；`justify-content:flex-end` 把工具组靠右）——**命中层同「代码块顶部不可选」那条**：header 整层 `pointer-events:none`，只让按钮恢复 `auto`。按钮开关走 props（`showModeToggle/showCopyButton/showFullscreenButton` 留，`showCollapseButton/showExportButton/showZoomControls` 关）。库的 UI 文案（Preview/Source/Copy/Close）走 `setDefaultI18nMap`（全局字典，17 个 key 全给，否则 TS 不过），但「Rendering diagram…」是**硬编码英文**，只能 CSS 变量 + `::after` 顶掉（组件侧把 i18n 文案塞进 `--md-mermaid-rendering`）。

**接入点 6 · 顺带把 katex 带进来了**。装 mermaid 会装上它依赖的 katex，于是公式从「显示源码」变成「渲染」——但 `katex/dist/katex.min.css` 没引入时 `.katex-mathml` 层不会被隐藏，公式**重影**成 `E = mc²E = mc2`。已显式声明 katex 依赖 + 在 `Markdown.tsx` 引入 CSS。生产（file:// + CSP `font-src 'self' data:`）实测字体能加载：20 个 KaTeX face 注册、用到的 3 个 status=loaded，无 CSP 违规。

**验证手法（可复用）**：seed 一条含图表/公式/故意写坏的 mermaid 的会话 + CDP 截图；CSS `:hover` 只认真实指针，必须 `Input.dispatchMouseEvent({type:'mouseMoved'})`（合成 MouseEvent 只触发 JS handler，见上文那条）；想通过 dev 输入框发真请求时，注意 composer 是受控组件且**第一个 textarea 是 `.ime-text-area`（readOnly，IME 辅助层）**，要定位真正的 composer（`.max-h-[200px]`）并用 `Input.insertText`。本案未能用真实模型做流式复验（dev 的 `~/.pi/agent-dev/auth.json` 已失效，401），近似做法是造一条「围栏没闭合」的会话：实测正常出图、无误判。LAN 版仍是源码卡（它有自己的 `Markdown.tsx`，mermaid/katex 都被 alias 成空 stub，单文件体积不受影响）。

### dnd-kit：`onDragStart` 里 `active.rect.current.initial` 恒为 null（2026-09-05）

`activeRects` 是个 ref，初始 `{initial:null, translated:null}`，**在 onDragStart 分发之后的 effect 里才填充**——事件回调里读到的永远是 null。要拖拽起始尺寸：给可拖节点加 `data-tab-id` 之类的锚点，回调里 `querySelector` 实测（SessionTabBar ghost 宽度就是这么做的）。

### UI 文案走 `useT()` + `zh`/`en` 字典（`renderer/src/i18n/`）

新增字符串两个都要加。

### store 级 `error` 字段永不清理 + 裸字符串渲染 = 报错跨会话残留（2026-09-12 修复）

症状：新会话空态页 Logo 下方永远悬着一条红色报错（如 `Error invoking remote method 'session:setModel': ...`），切会话/新建会话都不消失。根因：`useSessionsStore` 曾有全局 `error` 字段，7 处 catch 写入却无处重置，唯一渲染点是 EmptyState 里一段裸 `<p>`（统一报错系统建立前的遗留）。教训：**会话动作类失败（建/开/分叉/撤回/切模型）是 UI 动作反馈，走 toast（非阻塞自动消失），不进 store 长期态**；乐观更新失败按 `setSessionPermissionMode` 范式回滚。已删字段改 `pushToast` + 乐观回滚；`errText` 顺带剥 Electron IPC 包装前缀（`Error invoking remote method 'x': Error: `）保证 toast detail 可读。后续任何新 catch 不要再往 store 塞裸错误字符串。

### 长会话切会话卡顿（挂载窗口 + ToolCallCard 布局抖动）（2026-09-12 修复）

**症状**：会话跑两三小时后，从顶栏切到这条会话明显卡顿 ~1s（切回声短的会话不卡）。

**实测**（CDP + `Profiler` 采样，生产构建；1278 条消息的会话）：切一次 = 一个 ~900ms 长任务，成本三份——

| 占比 | 来源 | 机制 |
|---|---|---|
| ~50% | `ToolCallCard` 溢出测量 | 每张卡在 effect 里读 `getBoundingClientRect`×2 + `clientWidth`，且**每张卡自建一个 ResizeObserver**；几百张卡同一次提交里测量与 setState 引发的重渲染交替，每次读都落在布局已失效状态 → 整个消息流被重排几百次 |
| ~25% | markdown / monaco 代码块 | 每个历史代码块都在这次提交里初始化（shiki 语法编译 + monaco 实例） |
| ~25% | React 挂载 1.6 万个 DOM 节点 | 长会话全量挂载 |

**修复**（两处互补，`renderer/src/components/chat/`）：

1. `mount-window.ts` + `MessageList` 挂载窗口：切会话只挂尾部 40 行，更早的行在用户上滑接近顶部（`scrollTop < 1000px`）时成块补挂 30 行；**窗口只增不减**（不做反向回收，避开卸载顶部导致的滚动跳变）。切会话的挂载量与会话长度解耦，实测该场景降到 ~190ms（其中还包含卸载上一个会话的 1.6 万节点）。
2. `ToolCallCard` 模块级测量调度器：一帧内所有卡片的测量合并成「先读后写」（读集中在一个 rAF 的读阶段 = 一次布局，写统一 setState = 一次渲染），ResizeObserver 从每卡一个改为全卡共享一个。调度器要带定时器兜底（rAF 优先、250ms 定时器兼底，同 `stores/event-conflator.ts` 约定）——否则窗口隐藏时 rAF 停摆，队列会一直卡着不 flush（实测初版就是这个局面：`_sched` 计到 220、`flush` 恒为 0，卡片永远停在「不溢出」态）。

**补挂不能破坏视口位置**（新内容整块插在视口上方会顶走当前阅读位置）：**锚定交给浏览器滚动锚定**（`overflow-anchor` 保持默认 auto，容器绝不能加 `none`），`useLayoutEffect` 里只用「补挂前旧首行的视口相对 top」做漂移兜底（浏览器已钉住时 drift === 0，是 no-op）。

> ⚠️ 初版是反的：容器加 `[overflow-anchor:none]` 关掉浏览器锚定、每次补挂按「旧首行 `offsetTop` 差值」手写补偿 `scrollTop`。这个写法**只看提交那一刻的高度**，而 markstream 的内容是**异步定型**的（见下条），于是有 0.5.7 的线上 bug：用户上滑时被反复拽回底部。验尸结论：**不要把滚动锚定从浏览器手里拿回来。**

**二次修复（2026-09-13，0.5.7 线上 bug：上滑被反复拽回底部）**：症状是「加载长会话后向上滚，位置一直被重置回下面」。根因链：

1. markstream 的行先渲染成一个 **600px 的占位容器**（`.markstream-react.markdown-renderer`），100–300ms 后才收成真实高度（实测 600 → 42–66px）——真实大会话切进去一次就 **-4391px**；补挂进来的 30 行同理，每次再缩 ~2000px。
2. 容器 `overflow-anchor: none` ⇒ 浏览器不补这个高度变化 ⇒ 视口上方内容变矮就把 `scrollTop` 往下钳（钳到底部）。
3. `handleScroll` 看到 `atBottom === true` 就 `updateFollowing(true)` 复活跟随 ⇒ 用户被钉在底部，再上滚又被下一次缩水钳回来——「一直重置位置回下面」。

修复：把锚定交回浏览器（它同时补偿「补挂插入」与「异步定型缩水」两类视口上方高度变化），手写补偿只兜底 **Chromium 在 `scrollTop === 0` 时不调整锚点**这一种情况（到顶了没地方调；此时按锚点视口位置漂移补差，残留 ≤ 一行）。A/B 实测（真实轮事件上滚 55 步，检查「视口顶行距尾部的序号单调不降」）：旧实现 **11 次违规**，浏览器锚定 **0 次**。

**验证这类滚动 bug 的可复用不变量**：不要看 `scrollTop` 数值（程序性补偿本来就会大跳），看**视口顶部那一行「距尾部行数」的序号**——用户上滚时它只能单调增大（走向更早的行），任何变小的跳变就是「视口被拽向对话后面/底部」。脚本用 CDP `Input.dispatchMouseEvent({type:'mouseWheel', deltaY:负数})` 产生**真实轮事件**（合成 `scrollTop` 赋值测不出这类 bug；注意 `deltaY` 正值是向下滚，别搞反）。

**三次修复（2026-09-16，0.5.8 线上 bug：已完成会话上滚滚不动、贴底吸附）**：二次修复把锚定交回浏览器后，「被重置回底部」没了，但遗留「上滚被顶住」——根因是对 600px 占位的诊断不完整：那不是挂载时的一次性「异步定型」，而是 markstream-react 容器 CSS `:where(.markstream-react).markdown-renderer{contain:layout; content-visibility:auto; contain-intrinsic-size:800px 600px}`——**视口外的每条消息都按固定 600px 估值占位（无 `auto` 记忆），滚近才恢复真实高度，滚远又退回 600px，双向往复**。上滚时真实高度 ≫600 的消息进入渲染窗口突然「长高」，浏览器滚动锚定为保持视口稳定把 scrollTop 往下推，抵消用户滚动（实测一轮 -120 的滚轮：内容 +605px，scrollTop 净 +486）；被推回距底 ≤48px 还会复活跟随 → RO 钉底，即「吸附」。「大力滚」能上去只是因为快速跳过了估值失真区。为何只有个别会话中招：消息真实高度大多 <600 时会话是「缩水助推上滚」几乎无感；含超长正文（如实测 5393 字分析文）的会话才是「长高顶回」。

修复：`globals.css` 加覆写（库全走 `:where()` 零优先级，普通选择器即可压掉）——`.markdown-body .markdown-renderer` 与 `.markdown-body .code-block-container`（同款 `content-visibility:auto` + 180px 估值，同机理）均设 `content-visibility:visible; contain-intrinsic-size:none`。只停「跳过渲染」，布局隔离（contain）保留；长会话渲染成本控制本就由挂载窗口承担。修后实测：滚轮 -120 × N 步长精确无回弹，scrollHeight 全程稳定。

**诊断手法增量**：抓「谁在变高」用两轮全量后代 `offsetHeight` 快照 diff（滚动前后各一份，按挂载序号对齐），一眼定位到 600→42 的 `.markstream-react` 容器；再回库 CSS 里 grep `contain-intrinsic-size` 即破案。复现/验证脚本：`.local/debug/repro-scroll.mjs`、`what-grows.mjs`。

**测量手法可复用**（`Profiler` + `Runtime.evaluate`，脚本模式见 AGENTS.md 的 CDP 一节）：① `Profiler.start/stop` 取采样按 `callFrame` 聚合自耗时，比猜快得多（本次一眼看到 338 个样本叫 `getBoundingClientRect`）；② 想知道「谁在强制重排」就在页面里包 `Element.prototype.getBoundingClientRect` / `offsetHeight` getter，采样调用栈字符串；③ 验证窗口类改动用 DOM 探针（`elementFromPoint` + `rect.top` + 行数）而非截图。

**坑**：窗口隐藏（锁屏/最小化/被挡住了）时 rAF 不跑——用 rAF 做等待条件的测量脚本会**永久挂住**（表现为 CDP 调用超时，页面 CPU 却是 0），且滚动的 `scroll` 事件也在渲染生命周期里派发，隐藏态不自动触发（需手动 `dispatchEvent(new Event('scroll'))`）。判断：`document.hidden`。

**解法**：脚本开头补一次 CDP `Emulation.setFocusEmulationEnabled({ enabled: true })`——页面被置为可见（`document.hidden` 变 false）后 rAF 恢复、原生 `scroll` 事件也照常派发，无需再手动 dispatch。

**复核（生产构建 `npm run build` + `npx electron . --remote-debugging-port`）**：切 1600 条消息 / 3200 行的会话**首帧 16–20ms**、真实长会话（1278 / 1370 记录）**37–51ms**，长任务均为空；连续 8 次上滑补挂（每次 +30 行）长任务全空；贴底跟随时新增行仍贴底。

挂载窗口的两个已知面：① **切走再切回窗口复位回尾部 40 行**（每次切换成本恒定，不会越用越慢）；② 窗口只增不减 ⇒ 滚过的行一直挂着，DOM 上限 = 该会话全量（换来的好处是不做反向回收、无滚动跳变）。③ 页内查找不受影响：Electron 默认菜单没有 Find、代码也没调 `findInPage`，Cmd+F 本来就没有；将来若做消息搜索，应查 transcript store 而非 DOM，与挂载窗口无关。

### macOS 关窗 = 隐藏窗口：三个反直觉点（2026-09-17，issue #55）

行为：macOS 下点红点/⌘W → `preventDefault() + win.hide()`（app 继续跑，Dock 点回原窗口原状态）；⌘Q / 菜单退出仍要真退。

1. **hide 后 renderer 侧状态不可信**：`win.hide()` 之后 `document.visibilityState` **仍是 `"visible"`**，CDP `/json/list` 里 target 也照旧在，renderer 里看不到任何「我藏了」的信号。判断窗口是否隐藏只能回主进程（`win.isVisible()` / `isDestroyed()`）；renderer 侧写「隐藏时暂停 XX」的逻辑一定失效。反之：hide 后 renderer 确实还在跑（`backgroundThrottling: false` 下 100ms 定时器 3 秒 tick 32 次），流式事件不断。
2. **renderer 的 `window.close()` 不走 `BrowserWindow` 的 `close` 事件**：主进程 `win.close()` 会被 `close` 监听器拦下并隐藏（Electron 文档：与用户点关闭按钮同效，这是正确的测法），但 renderer 里调 `window.close()` 直接把窗口**销毁**（进程还在、`window-all-closed` 在 darwin 不退出）——**不要拿它测关窗拦截**。本项目仓库无 `window.close()` 调用，不影响用户路径。
3. **拦截了 `close` 就必须给「真退出」留后门**：否则 ⌘Q 也会被拦成「隐藏」而退不掉。做法：模块级 `quitting` 标志 + `app.on("before-quit", () => markQuitting())` 首行置位，`close` 处理器里 `if (process.platform !== "darwin" || quitting) return;`。验证手法：主进程里先 `win.close()` 确认「未销毁未可见 + 同 target + renderer 变量还在」，再 `app.quit()` 确认进程真的退出。

（主进程侧调试：dev 起 `--inspect=9229`，Node inspector 接上去 `Runtime.evaluate` 直接调 `BrowserWindow`/`app`；临时脚本 `.local/dev-logs/main-eval.mjs`。）

### 浮层退场时序与焦点接管（2026-09-17，issue #55）

- **退场动画必须等满再卸载**：`pop-out`（120ms，`forwards`）靠动画停在透明态，若节点提前卸载就会**闪回原样**（PreviewTicker 同坑）。约定：CSS 时长与组件里的 `EXIT_MS` 常量一对一，`setTimeout` 到点才调 `onCommit/onCancel`。
- **二级浮层抢焦点不能靠 `autoFocus`**：从菜单项点开的浮层里放输入框时，菜单节点在这一次点击里被卸载，浏览器会把焦点丢回 `body`，`autoFocus` 在 commit 阶段抛出的 `focus()` 被 click 收尾抹掉（实测 `document.activeElement !== input`、`selectionStart===selectionEnd`）。做法：挂载后 `requestAnimationFrame(() => { input.focus(); input.select(); })`。
- **退场动画的逐帧截图要劫持卸载定时器**：`document.getAnimations()` 全 `pause()` 只冻结动画时钟，`setTimeout` 照旧跑——退场帧还没截完节点就没了。手法：截图前把 `window.setTimeout` 换成一个「短延时全部缓存、手动触发」的版本，截完再还原并执行缓存回调。

### 右键菜单定位与脱锚（2026-09-17，issue #55）

- 菜单/浮层一律 **portal 到 `document.body` + `position: fixed`**：挂在被 `overflow: hidden/auto` 的祖先里会被裁切。
- 定位收成纯函数（`components/ui/place-menu.ts`）：锚点 = 触发元素 `getBoundingClientRect()`，规则 = 下沿左对齐 → 超右缘左翻（右缘贴触发元素右缘）→ 下方放不下且上方够则上翻 → 最后夹进视口内边距。**先渲染再测量**：菜单高度取决于行数，`useLayoutEffect` 里量完再 `setState` 定位，测量前整层 `visibility: hidden` 防抖动。
- **滚动/改变窗口尺寸就关菜单**（而不是重定位）：祖先滚动容器可能有很多层，跟踪成本远大于收益；不关会「菜单挂在原地、触发元素跑了」。
- `preventDefault()` 在 `contextmenu` 里必写（否则同时弹系统菜单）；dnd-kit 的 `PointerSensor` 只认主键，右键不会误触发拖拽。

## 五、工程纪律

### 别用 `npm run lint | tail -2` 判断「lint 通过」（2026-09-20）

症状：本地看 `npm run lint | tail -2` 只见 "No fixes applied." + "Checked N files"，判定全绿 → 推 PR → **CI 在 `Run npm run lint` 立刻挂**，报 3 个 **format** 错误（多余空行、超长行）。

两个原因叠在一起：① biome 的「Found N errors」打在输出**中部**，`tail` 正好看不到；② **管道会把 `$?` 换成 `tail` 的（恒为 0）**，退出码再也反映不了 lint 结果。

做法：`npm run lint > /tmp/lint.log 2>&1; echo "exit=$?"`，**exit code 与 `Found ... errors` 一起判**；PR 前至少跑「lint + typecheck + test + build」四件套（**format 错误 test 抓不到**）。另外 `npm run lint -- --write` 自动修完之后，若又用手写/脚本插入了新代码（本会话就是 python 插测试块），那些新代码仍是未格式化状态 → 改完要重跑并以 exit code 复核。

### `pkill -f` 杀 Electron 会留下孤儿 main 进程（2026-09-19）

症状：用 `pkill -f "MacOS/Electron ."` 这类**带通配的匹配**清理 dev 实例后，renderer/GPU 等 helper 被杀掉、main 进程却继续活着 —— 它仍占着调试端口（9224）与 dev userData，表现为「CDP 连得上、`document.body.innerHTML` 却是空字符串」，极易误判成代码把页面渲崩了。

做法：按**项目路径**精确匹配再杀，一次清干净：

```sh
pgrep -f "percho/node_modules/electron" | xargs -r kill -9
pgrep -f "electron-vite" | xargs -r kill -9
```

另外同时起两个 dev 实例时，只有**先启动**那个能绑上调试端口（后起的静默失败）；排查前先 `ps -eo pid,lstart,command | grep MacOS/Electron` 数一下进程。

### 绝不打印/提交 API key

`models.json` 用环境变量引用（`$AI_OPS_API_KEY`），key 由用户自持。

### 已开源：github.com/Jaxton07/percho

git remote 走 SSH（本机直连 github.com:443 不通）。`main` 有分支保护（PR + CI `check` 必过 + squash merge），Release 由 tag 触发（`.github/workflows/release.yml`）。
