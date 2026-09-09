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
| LAN 页连接僵死不重连、状态「重连中/已连接」反复跳 | 二 · SSE 心跳必须是命名事件帧 |
| LAN 对话页正文重复出现在末尾、run 结束又恢复正常 | 二 · 流式增量帧不可重放（healing 兜底差量） |
| 流式输出时整个 Markdown 区域随 token 节奏闪烁、尾部文字半透明往上爬 | 四 · markstream fade 的临时合成层（已修：组件 API 关闭 fade） |
| 代码块顶部两行无法拖选、标点偶发橙色框 | 四 · 悬浮 header 命中层 + Monaco Unicode 高亮 |
| onDragStart 里拿不到拖拽尺寸（`active.rect.current.initial` 恒 null） | 四 · dnd-kit rect ref 填充晚于 onDragStart |
| Google Vertex 填了 key 仍 401「API keys are not supported by this API」 | 二 · Vertex 只支持 ADC/服务账号（api_key 路径必败，桥接层已剔除 api-key 选项） |

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

### CDP 冒烟往 store 注入状态必须用完整对象形状（2026-08-29）

`cdp-eval` 里 `useSessionsStore.setState({ sessions: [ { sessionId: 'x' } ] })` 这类缺字段注入会炸渲染组件（如 `TabPill` 读 `session.name.split` → TypeError，错误边界兜住但 UI 白屏重挂）。安全手法：**不碰 sessions 列表**，只对 transcript `bySession` 做函数式合并注入完整 SessionEntry 形状（各字段齐备），测完删 key；或先存原 entry 引用、最后还原。同理不要整体覆盖 `bySession`（会抹掉真实会话，App 重载时连锁出错）。

### CDP 小区域 clip 截图偶发连续 blank，全窗截图正常（2026-09-06，permission-mode 手测）

症状：`Page.captureScreenshot` 带 `clip`（如 composer 底栏 560×95 的小区域）时偶发 4 次重试全 blank；同帧全窗无 clip 截图正常。与 AGENTS.md 已记的「偶发整帧空白」同类合成器瞬时状态，但**小 clip 更易触发且重试也救不回**。对策：能用全窗截图就全窗（事后裁）；必须要小区域时改用 DOM 计算样式断言（`getComputedStyle` 颜色/位置）代替像素级验证，别在重试上耗时。

### markstream fade 的临时合成层 = 整个 Markdown 区域随流闪烁（2026-09-05 初修，2026-09-08 根治）

症状：流式输出时正文随 token/commit 节奏整块闪一下；慢模型频率低，快模型频率高。库机制：`fade=true` 时每次可见文本 commit 都把新增量包进 `span.text-node-stream-delta`，跑 `opacity:0→1` 动画并带 `will-change:opacity`；动画结束后再沉淀进普通文本。除了尾部直接变淡，高频创建/销毁临时合成层还会让同一文本排版区域的合成/抗锯齿观感一起跳，看起来像整个 Markdown 被重绘。

2026-09-05 初修把 `--stream-update-fade-duration` 压到 8ms，只缩短了动画，没有消除临时 span 与合成层切换，仍会按模型输出频率闪。2026-09-08 根治：桌面和 LAN 的 `Markdown` 都从组件 API 传 `fade={false}`，保留 `smoothStreaming` 的 pacing。注意这与 CSS `animation:none` 不同：`fade=false` 会让库直接走稳定文本 span 分支，不创建 fading span，也不依赖 `animationend` 沉淀。

已排除的候选（实证手法可复用）：组件 remount / 整树重渲 / 块级 fade-node 重播 / controller.reset 重播（reset 是即时全亮）。给 store 注入合成 `text_delta`，页面侧用 MutationObserver + 节点身份采样 + `animationstart` 监听验证：`.markdown-body` / `.markstream-react` 身份不变，而开启 fade 时每个 smooth commit 都启动 `markstream-react-text-node-stream-update-fade-*`。次级因素：代码块 fence 打开后先渲纯文本 fallback 再换 Monaco（空闲时约 32ms，主线程忙时更长）。

### 代码块顶部不可选 + 标点橙框（2026-09-08）

两个独立原因。顶部不可选：为保留复制按钮而把 `.code-block-header` 绝对定位到代码块顶部，header 实际高 38px，恰好覆盖 18px 行高的前两行；`:hover/:focus-within` 曾把整条 header 设为 `pointer-events:auto`，透明区域也会截获拖选。修复为 header 始终 `pointer-events:none`，仅 `.code-action-btn` 恢复 `pointer-events:auto`。

标点橙框：Monaco 默认 `unicodeHighlight` 会给全角标点、不可见字符和易混淆字符生成 `.unicode-highlight` 描边，模型输出中混入这类字符时看起来像随机残留框选。只读展示没有可执行的修复动作，桌面与 LAN 的 `Markdown.tsx` 都通过 `monacoOptions` 关闭三类 Unicode 高亮，并一并关闭同词、符号 occurrence 和括号匹配 decoration；真实拖选高亮保留。诊断时用 `elementFromPoint` 检查顶部文本命中、`.view-overlays .selected-text` 检查 Monaco 内部选区；不要用 `window.getSelection()` 判断，Monaco 选区不走浏览器 Selection API。

### dnd-kit：`onDragStart` 里 `active.rect.current.initial` 恒为 null（2026-09-05）

`activeRects` 是个 ref，初始 `{initial:null, translated:null}`，**在 onDragStart 分发之后的 effect 里才填充**——事件回调里读到的永远是 null。要拖拽起始尺寸：给可拖节点加 `data-tab-id` 之类的锚点，回调里 `querySelector` 实测（SessionTabBar ghost 宽度就是这么做的）。

### UI 文案走 `useT()` + `zh`/`en` 字典（`renderer/src/i18n/`）

新增字符串两个都要加。

## 五、工程纪律

### 绝不打印/提交 API key

`models.json` 用环境变量引用（`$AI_OPS_API_KEY`），key 由用户自持。

### 已开源：github.com/Jaxton07/percho

git remote 走 SSH（本机直连 github.com:443 不通）。`main` 有分支保护（PR + CI `check` 必过 + squash merge），Release 由 tag 触发（`.github/workflows/release.yml`）。
