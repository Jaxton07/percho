# Percho 踩坑记录（来之不易，勿重踩）

> **遇到怪问题先来这里查**：疑难 bug、构建/打包异常、SDK 行为反直觉——先按下方「症状快速索引」找条目，再决定要不要自己踩一遍。
> 配套阅读：`docs/INDEX.md`（项目索引，「想改 X 改哪里」）；AGENTS.md「UI 截图调试」「常用命令·本地内测打包」两节还有各自的实操坑。
> 新踩的坑记到这边（注明日期与修复点），别只在会话里说。

## 症状快速索引

| 症状 / 场景 | 条目（章节） |
|---|---|
| 全 app 卡死、日志/磁盘分钟级 GB 暴涨、renderer unresponsive | 一 · 0.4.6 冻结事故 |
| 流式期间白屏、`error #185`、无限重渲染整树卸载 | 一 · 0.5.0 白屏事故；四 · Zustand selector（#185 另一成因） |
| 点击对话里的相对文件链接后白屏 | 四 · Markdown 相对链接会导航 app 主窗口（2026-09-23） |
| 比像素核验视觉时取样偏了、以为改动没生效 | 四 · CDP `clip.scale` 再乘一次 DPR（2026-09-29） |
| 拖动类脚本跑完后界面卡在「拖动中」（光标仍是 col-resize、之后再拖也不动） | 四 · CDP 合成拖拽的两个卡死姿势（2026-10-07） |
| 侧栏拖宽后把手抓不住 / 行末按钮点不到，**截图看却完全正常** | 四 · 比列宽更宽的内容溢出吃 pointer 事件（2026-10-07） |
| `verify-layout-freedom` 的 V2 拖拽断言一片红（把手点不到） | 四 · 左栏把手偶尔命中不到 / V2 断言一片红（**2026-10-07，成因未定位；常态 43/0**） |
| 改了代码字号档位，monaco 代码块字号纹丝不动 | 四 · monaco 只在创建编辑器时应用 options（字号必须在 props 变化时重建代码块） |
| 注入页面的探针函数报 `SyntaxError: missing ) after argument list` | 四 · 把含反引号/`${}` 的函数塞进模板串注入（要 JSON 后再 eval） |
| 侧栏拖一次后**整窗光标卡在 col-resize**、之后再也拖不动（刷新才恢复） | 四 · 拖拽只挂 pointerup 会在「窗口外松手」后永久卡死（2026-10-07） |
| 脚本判定「没生效」但代码明明改了 / 文件里是新值而界面是旧值 | 四 · dev 里 HMR 会让 store 订阅冻结，验收前要硬重启（2026-10-07） |
| hover 态截图时有时无、想稳定截出 hover 视觉 | 四 · 同上（`CSS.forcePseudoState` 钉伪类）（2026-10-07） |
| 绝对定位「撑满父容器」的元素命中区高度是 0（`<hr>` 尤其） | 四 · Tailwind preflight 的 `hr { height: 0 }` 盖掉 `top/bottom: 0`（2026-10-07） |
| 脚本复位 inline style 后组件样式莫名回退（React 写的 CSS 变量被抹） | 四 · 别用 `cssText = ""` 复位（2026-10-07） |
| 重启后窗口跑到屏幕左边约 221px（位置记忆看似失效） | 六 · macOS 首次 `show()` 会把窗口 x 抬到 ≥221（2026-10-07） |
| 最大化状态下退出，重启窗口变成超大 / 位置超出屏幕 | 六 · 持久化窗口 bounds 必须用 `getNormalBounds()`（2026-10-07） |
| 监听窗口位置/尺寸变化收不到事件（`resized`/`moved` 从不触发） | 六 · macOS 只来 `resize`/`move`，且一次动作可能来好几次（2026-10-07） |
| 极端情况丢偏好：关窗瞬间的那次写盘 | 六 · 退出兜底要同步写（`updateSync`），但它不参与写盘队列（2026-10-07） |
| `npm run test` 偶发红、失败点在 backend `channel-watch-extension.test.ts` | 三 · 既有 flaky：cursor 落盘竞态（2026-10-07） |
| 弹窗蒙层只盖住一列 / 卡片被左栏「吃掉」半边 / 测量位置却是对的 | 四 · `.edge-fade` 的 mask 把 fixed 浮层的绘制裁在容器盒里（2026-10-06） |
| 改了滚动条宽度但截图里看不到，以为没生效 | 四 · CDP 截图不绘制滚动条，只能力槽宽（2026-09-29） |
| 扩展注册的工具模型用不了、模型说「工具列表为 none」 | 二 · createAgentSession tools 白名单 |
| 升 SDK 后 `tsc` 全绿但测试红、只红一两条 | 二 · SDK 升级 0.84.3 → 1.0.4：typecheck 全绿 ≠ 无行为变化（2026-10-06） |
| 要判断「会话落盘了没」/ 新建未发消息的会话改名 | 二 · 同上（`sessionFile` 路径先行、文件延迟落盘） |
| 撤回后上下文还带着被撤回的消息 / 消息数不变 | 二 · 同上（手写 `agent.state.messages` 已无效；手动回退 leaf 要补 `refreshContext()`） |
| 设置页永久 Loading、模型列表为空 | 二 · runtime.refresh 网络挂起 / getAvailable 返回空 |
| 权限 confirm 弹窗不生效 | 二 · bindExtensions 注入点 |
| preload 加载失败（sandbox 下 require is not defined） | 三 · preload 必须 CJS |
| main 进程 import workspace 包行为异常（外部化/旧产物） | 三 · externalizeDepsPlugin |
| 打包产物缺 pi SDK、Electron 版本漂移 | 三 · 打包两个坑 |
| Release 的 macOS job 在 `electron-vite build` 末尾 exit 134 / JavaScript heap out of memory | 三 · Release renderer 构建要显式提高 Node 堆上限（2026-09-21） |
| Electron 二进制下载不动、npm 拦 postinstall | 三 · Node/npm 环境 |
| gh 合并报 workflow scope / fork 首 PR 合不了 | 三 · gh CLI workflow scope |
| 新增 UI 文案只显示一种语言 | 四 · i18n 双字典 |
| 凭证泄漏风险、密钥误提交 | 五 · 绝不打印/提交 API key |
| LAN 页连接僵死不重连、状态「重连中/已连接」反复跳 | 二 · SSE 心跳必须是命名事件帧 |
| 重开会话后某条 UI 痕迹没了（压缩分割线消失） | 二 · compaction entry 能回放，且它不存原因/压缩后估值（2026-09-29） |
| LAN 对话页正文重复出现在末尾、run 结束又恢复正常 | 二 · 流式增量帧不可重放（healing 兜底差量） |
| 流式输出时整个 Markdown 区域随 token 节奏闪烁、尾部文字半透明往上爬 | 四 · markstream fade 的临时合成层（已修：组件 API 关闭 fade） |
| 代码块顶部两行无法拖选、标点偶发橙色框 | 四 · 悬浮 header 命中层 + Monaco Unicode 高亮 |
| mermaid 代码块只显示源码卡不渲染、图表挤成一行不换行 | 四 · mermaid 卡接入（optional peer dep + isStrict + 失败态静默）（2026-09-18） |
| markstream 自定节点组件传 `customComponents` prop 无效 | 四 · mermaid 卡接入 → 接入点 1（只有全局 `setCustomComponents`） |
| 公式渲染成两份文字（`E = mc²E = mc2`） | 四 · mermaid 卡接入 → 接入点 6（缺 katex CSS） |
| onDragStart 里拿不到拖拽尺寸（`active.rect.current.initial` 恒 null） | 四 · dnd-kit rect ref 填充晚于 onDragStart |
| 报错文案悬在空态页不消失、切新会话还在 | 四 · store 级 error 字段永不清理（已修：改 toast + 乐观回滚） |
| 切到长会话卡顿约 1 秒、消息多的会话越久越卡 | 四 · 长会话切会话卡顿（挂载窗口 + ToolCallCard 布局抖动）（2026-09-12 修复） |
| 有内容的会话开右侧变更栏掉帧，新会话却丝滑 | 四 · 右侧栏 width push 动画导致聊天区逐帧重排（2026-09-21） |
| 已完成会话上滚滚不动、要大力滚，贴底还吸附（0.5.8 线上 bug） | 四 · 长会话切会话卡顿 → 三次修复（markstream content-visibility 600px 估值占位）（2026-09-16 修复） |
| 长会话里上滚，位置被反复重置/拽回底部（0.5.7 线上 bug） | 四 · 长会话切会话卡顿 → 二次修复（markstream 占位条缩水 + 手写滚动补偿）（2026-09-13 修复） |
| 改了 `src/main/` 但 app 行为没变（dev 不重建主进程） | 三 · electron-vite dev 主进程 watcher 不可依赖（2026-09-17） |
| 关窗后 renderer 还活着、`visibilityState` 仍是 visible；用 `window.close()` 测不出关窗拦截 | 四 · macOS 关窗 = 隐藏窗口（2026-09-17） |
| 拦下关窗后窗口再也关不掉；渲染进程死循环也收不到 `unresponsive` 事件 | 四 · 关窗拦截必须留「渲染进程卡死」兑底（2026-09-21） |
| 浮层/菜单退场闪回（节点被提前卸载）、二级浮层输入框没聚焦 | 四 · 浮层退场时序与焦点接管（2026-09-17） |
| 右键菜单贴边溢出视口、滚动后浮层脱锚 | 四 · 右键菜单定位与脱锚（2026-09-17） |
| Google Vertex 填了 key 仍 401「API keys are not supported by this API」 | 二 · Vertex 只支持 ADC/服务账号（api_key 路径必败，桥接层已剔除 api-key 选项） |
| 跨会话频道里对方迟迟不查收、回复总晚一整轮（实施在改文件、review 却在跑回归） | 二 · sendUserMessage 默认 followUp = 等对方 turn 结束才投递（2026-09-17） |
| 新会话页的 picker 改动「点了没反应」、promotion 用的项目/模型和页面显示的不是一回事 | 五 · 新会话页不变式：active=null ⇒ 必有 draft，且 cwd 严格镜像 draft.cwd（2026-09-20） |
| CDP 验收脚本里想注入 IPC 失败/统计调用次数，改写 `window.pi` 却毫无反应 | 五 · contextBridge 暴露的 API 在页面里只读（2026-09-20） |
| 逐帧截图全是空白/同一张陈旧图、rAF 像停摆 | 四 · 合成器空帧与「暂停动画不出新帧」（2026-09-19 补） |
| 验证脚本读出「旋转没生效」（`transform: none`）但界面明明转了 | 四 · Tailwind 4 的 `rotate-*` 走 `rotate` 属性不是 `transform`（2026-09-19） |
| 脚本里手动删了 React 的节点，随后整页「界面出现异常」（removeChild 报错） | 四 · 别手拆 React 管理的 DOM（含 portal 浮层）（2026-09-19） |
| 用渲染层 JS 堆证明「卸载会话能省内存」，结论反了 | 四 · 渲染层的大头是模块级基建，不是会话数据（2026-09-20） |
| 左栏有图钉、顶栏却没有胶囊（「置顶了但不显示」） | 四 · 顶栏内容要由置顶表驱动，别从 tabs 里筛（2026-09-19） |
| 后端日志出现 `context-evaporation` / stale ctx 报错 | 二 · 删除正在跑的会话会留 stale ctx（既有现象，2026-09-20 记录） |
| hover 才现的控件刚截完图就点不到、点击静默落空 | 四 · 鼠标事件 + `:hover` → 补「截图会清掉 hover」（2026-09-19） |
| 某个区域内滚轮完全失灵（内层没内容、外层也不滚）；给不溢出的滚动容器挂了 `overscroll-behavior: contain` | 四 · 嵌套滚动的归属验证 + contain 吞 wheel（2026-09-21） |
| CDP wheel 验证“滚动该归谁”时假失败/假绿（落点被浮层盖住、或拿赋 `scrollTop` 冒充滚动） | 四 · 同章节「验证滚动归属的三条纪律」（2026-09-21） |
| 命令式写的 DOM 属性过一会儿变回旧值/初值（React 重渲染冲掉） | 四 · 别手拆 React 管理的 DOM → 补「命令式改 JSX 已声明属性」（2026-09-21） |
| 改完自定义 hook 后整页报「Rendered fewer hooks than expected」 | 四 · HMR 改 hook 数量会假报错（2026-09-19） |
| 清理 dev 进程后端口还占着、CDP 连上但页面全空 | 五 · `pkill -f` 杀 Electron 会留下孤儿 main（2026-09-19） |
| 跨会话频道订阅后，会话被卸载/关闭期间的消息永久丢失（或反过来重复提醒） | 二 · 长生命周期订阅不能挂在可被自动 GC 的会话上（2026-09-20） |
| 有频道订阅的会话仍被自动卸载（或被用户关）→ 从此收不到唤醒 | 二 · 同章节「订阅 = 明确驻留语义」 |
| 恢复后把对端历史消息当新消息提醒、或每次重开都重提醒一次 | 二 · 同章节「游标缺 key ≠ null」 |
| 组里最后一个展开的项目折不掉、切会话又自己展开（空数组身兼两义） | 四 · 空数组不能同时当「未初始化」与「有效空值」（2026-09-20） |
| 打开模型选择器后整页向左偷跑、左栏与顶栏左侧按钮被挤/裁切 | 四 · absolute 弹层越界 + autoFocus = 整页横向偷跑（2026-09-20） |
| CDP 量测得出「弹层在视口内、也没滚动」但界面明明错位（量错元素） | 四 · 同章节「量测三纪律」（2026-09-20） |
| 进度条/比例条的渐变颜色跟着填充长度变（像被拉伸/压缩） | 四 · 渐变填充别直接改 `width`（2026-09-29） |
| 自绘滑块在最低档时左半边有一道描边（填充的圆角帽露在滑块圆外） | 四 · 同章节「填充端要跟滑块圆对齐」（2026-09-29） |
| 截图里自定义滚动条完全不出现，量 `offsetWidth - clientWidth` 又是 0 | 四 · headless 不绘制 `::-webkit-scrollbar`（2026-09-29） |
| 量测脚本报「draft 没进左栏」，实际是我的选择器点到了分组头 | 四 · 同章节「量测三纪律」→ 侧栏行选择器（2026-09-20） |
| 点一下历史会话行，它在左栏里跳到别处（卸载后又跳回） | 四 · 内存 meta 覆盖历史 meta = 排序键漂移到 createdAt（2026-09-20） |
| 快速连点两行，界面停在先点的那一行（或过一会才被抢回） | 四 · 异步导航必须 latest-wins（令牌 + 共享 open pipeline）（2026-09-20） |
| 同一会话文件并发 open 后订阅/扩展/trace 翻倍、旧实例泄漏 | 二 · openSession 幂等：registry 短路 + single-flight + add 不静默覆盖（2026-09-20） |
| 复制/恢复过会话文件后，它在列表里的时间/位置全变了 | 二 · 同章节「birthtime 不是会话创建时间」 |
| 新建的会话过一阵突然从左侧栏消失（点「＋」/重启后又回来） | 四 · 会话目录写穿：行存不存在不能依赖内存（2026-09-21） |
| 左栏会话标题在项目目录名（如 `percho`）与首条用户消息之间反复切换 | 四 · 同章节「名称也要写回目录投影」（2026-09-22） |
| 会话压缩后当时历史还在，过段时间重新打开却只剩压缩后的内容 | 四 · UI 历史不能读取被压缩的模型上下文（2026-09-22） |
| 打开历史会话恰好收到频道唤醒，页面只剩唤醒后消息、磁盘历史还在 | 四 · 打开期间流式事件抢先建立 transcript，历史快照被丢弃（2026-09-29） |
| 给 store 加模块级订阅后，某些入口报 `Cannot read properties of undefined (reading 'subscribe')` | 四 · 同章节「renderer 模块图不许有环」（2026-09-21） |
| 反复被 GC 卸载的已置顶会话，顶栏胶囊也一起消失了 | 四 · 同章节「写穿」：胶囊与左栏同源（tabs → 目录兜底） |

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

### compaction entry 能回放，且它不存原因/压缩后估值（2026-09-29）

**通用教训**：只活在实时事件里的 UI 痕迹（压缩分割线、输入框上方的临时提醒）重开会话必然消失——回放只认会话树 entry。压缩分割线就是这个坑：`compaction_start/end` 事件产的那条线重开就没了，而磁盘上其实**一直有** `type:"compaction"` 的 entry 被回放函数 filter 掉了（`toBranchSessionMessages` 原来只收 `type === "message"`）。

它的**位置天然正确**：`appendCompaction` 追加在当时 leaf 之后，所以按分支顺序把它插回消息流，分割线就落在"当时压缩的那一处"（实测 1833 条 entry 的分支上两条分别落在 145/1121、484/1121，前后消息 timestamp 单调）。

**形状（SDK 0.84.3 实测 20 条；1.0.4 多一个 `systemMessage`（压缩边界的完整 prompt/tool 状态），其余字段不变）**：`{ type, id, parentId, timestamp(ISO 串), summary, firstKeptEntryId, tokensBefore, details:{readFiles,modifiedFiles}, usage, fromHook }`。**没有 `reason`**（手动/阈值/溢出都不记），**也没有压缩后估值**（`estimatedTokensAfter` 只在事件里）——所以回放的分割线只能显示「已压缩上下文 · 压缩前 156.4k」+ 可展开摘要（摘要是同一条字符串，展开内容与实时一致）。想与实时逐字一致（带原因 + `x → y`），只能自己在 `compaction_end` 时补写一条 `custom` entry（`appendCustomEntry` 不进 LLM 上下文，撤回标记 `message-recalled` 同款）。

**加 role 的连带坑**：`SessionMessage` 新增 role 时，LAN 的 `sanitizeSessionMessage` 会把未知 role 落进最后那个 subagent 分支（`message.runs.map` 直接抛错）——新 role 必须在里面显式加分支。

### 长生命周期订阅不能挂在「可被自动 GC 的会话实例」上（2026-09-20，channel-watch retention + 持久补投）

背景：channel-watch 的 watcher 与订阅集都是**会话实例内的内存态**，而 renderer 的内存策略会把「空闲且不受保护」的会话 `dispose()` 掉。结果就是：会话一被卸载（或用户关掉），订阅无声消失——对端以为「已经通知过」，消息永久丢失；更糟的是用户看不出来（左栏那个会话还在，只是它不再收唤醒）。修复落在两处（`PiBackend.closeSession(id, intent)` + renderer 内存策略 + 落盘内容游标），四条不易自己想到的事实：

1. **订阅 = 明确驻留语义**：有有效运行态订阅的会话必须排除在自动回收之外（含「晾过 idleTimeout」的兜底路径），且**不占** 保留名额（K=3 是「可回收空闲」的名额，不是总会话数）。判定要用 backend 的**运行态快照**（扩展上报），不要用 UI 列表/设置偏好：`disabled`/`untrusted` 的订阅根本收不到唤醒，保护它只会白占内存。自动卸载与用户主动关/删要走**两个意图**（`intent:"gc"` 才被订阅挡，用户意图优先），否则用户会发现「这会话关不掉」。
2. **恢复只能靠会话文件条目回放**：游标（`MESSAGES.md` 内容 hash）必须和订阅集写在**同一条**快照里（分开写会出现「新订阅配旧游标」的中间态，恢复时要么补历史要么吞消息）；`cursors` 里**缺 key（旧载荷，未知基线）= 只记当前版本不补历史**，与值为 `null`（确认时文件不存在）语义不同，别用 `Map.get()` 把两者混淆。
3. **「自己写的」不能无条件推进游标**：必须先确认**写前磁盘版本 == 游标**，否则会把「对端已写、我们还没提醒」的内容吞掉（`paused` 期间的写入、或落在 watcher 防抖窗口里的外部写入同样算未确认）。要拿到写前版本，得在 `tool_call` 钩子里读（SDK 会在工具真正执行前 `await` 这些钩子）；拿到之前先想清楚「这条推进会不会跨过一个还没提醒的版本」。
4. **所有跨 `await` 的续体都要复查生命周期**（`active/trusted/订阅`）：shutdown/退订完全可能落在「读盘 ↔ 起 watcher」之间，不复查就会出现幽灵投递、幽灵游标、孤儿 watcher。watcher 的 single-flight 推荐用 `p.then(settle, settle)` 而不是 `void p.finally(settle)`——`finally` 会派生新 promise，`p` 意外 reject 时变成未处理拒绝。

**本期未覆盖的已知限制（缺口）**：轮询降级模式的删除检测（`readdir` 快照里不含被删文件）与 watcher root 目录被删后重建——这两种异常场景下 watcher 会**漏事件**（订阅会话仍在，但那一次变化不会投递），不影响本期主故障（会话被卸载导致订阅整个消失）的验收，但它们是真实缺口、本期明确不修，不要当成「不是 bug」。

### openSession 幂等：registry 短路 + single-flight + `add` 不静默覆盖（2026-09-20，sidebar-session-switch-stability）

症状：同一个会话文件被重复打开（renderer 双击同一行、sidebar 与「子代理跑卡」两条路同时开、别处再调一次 open）后，这个会话的**订阅/扩展/trace 全变成两份**；关闭它只 dispose 掉后注册的那一份，前一份变成没人能关的活会话（内存、watcher、事件转发都翻倍）。查日志能看到同一 sessionId 的 `session opened` 出现两次。

根因有两层，都要堵：

1. `SessionRegistry.add()` 原来是 `Map.set` —— **静默覆盖**旧 entry，旧实例没人再持有引用，永远不会被 dispose；
2. `PiBackend.openSession()` 每次都从头构造 AgentSession，**从不回头看 registry**（哪怕这个 sessionId 已经在内存里）。

对策（三层，缺一层都可能漏）：

- `openSession` 用 **`resolve(filePath)` 规范化绝对路径做 key** 跑 single-flight（同一文件并发 open 共享一次构造；settle 后必清 key → 失败可重试）；
- 取到 header 拿到 sessionId 后**先查 registry，命中就直接返回现有 entry 的 meta**（`toMeta`）——短路必须放在 `getModelRuntime()`/资源 loader/扩展构造**之前**，否则照样白构造一遍；
- `registry.add()` 改成同 entry 幂等、**不同 entry 同 sessionId 抛错**；`wireSession` 里接住这个错，把刚构造的 `unsubscribe/gate.dispose/dialogs.dispose/session.dispose` 全做掉再重抛（这是并发/别名路径的最后防线，不能只抛错把资源漏出去）。

### birthtime 不是会话创建时间（2026-09-20，sidebar-session-switch-stability）

症状：复制/恢复/迁移过会话文件（或从别的机器拷回来）后，这个会话在列表里的“创建时间”变成今天、置底或置顶、排序也乱；另一个更隐蔽的版本是我们把“内存活跃会话”的 meta 直接覆盖磁盘 meta，**一打开某个会话它就从列表当前位置跳走**（详情见四 · 内存 meta 覆盖历史 meta）。

根因：`statSync(file).birthtimeMs` 被当成 `createdAt` 用。birthtime 是**文件诞生时间**，copy/restore 就变，跟会话本身没关系；而 SDK 自己用的是 session header 的 `timestamp`（`buildSessionInfo()`：`created = header.timestamp`、`modified = user/assistant 消息最大活动时间`）。

对策：活跃会话的时间字段只从**会话内容**取（header + entries，见 `backend/src/session/meta.ts`），`stat`/`Date.now()` 只在 header 读不出来时兜底，且**兜底也优先 mtime 而不是 birthtime**。自己实现枚举时，`custom`/`toolResult` 类 entry 一律不算活动——否则 channel cursor 之类的扩展写入会把会话顶到最前。

### SDK 升级 0.84.3 → 1.0.4：typecheck 全绿 ≠ 无行为变化（2026-10-06，pi-sdk-1.0-upgrade）

症状：依赖升到 1.0.4 后 `tsc` 零报错（`pi-backend.ts` 里的调用一行没改也编得过），但 `npm run test` 有两
条红（`backend/test/compaction-image.test.ts`，`expected ["string"] to deeply equal ["text"]`）。升 SDK 时
「编译过 = 没事」不成立，必须跑全量测试 + 手测。

三条静默行为变化（都在类型上不报错）：

1. **compaction 摘要请求的 context 形状变了**：`buildSummarizationContext()` 走新的 `normalizeContext()`，
   `systemPrompt` 被归一成 `messages[0]` 的 `role:"system"` 消息、content 是**纯字符串**（0.84.3 是独立的
   `systemPrompt` 字段，messages 里只有 block 数组的 user 消息）。断言「每条 message 的 content 都是 text
   block 数组」的测试因此红。→ 按「纯文本」语义断言：content 是字符串 或 只含 text block 的数组，
   且任何 image block 都判回归。
2. **`context` 钩子的 wire 从此不含 system 消息**：1.0.4 在调 handler 前 `filter(m => m.role !== "system")`、
   返回时 `restoreSystemMessages()` 复原（`core/extensions/runner.js` 的 `emitContext`）；0.84.3 是直接透传。
   **但对我们的蒸发无影响**：`extractMessageParts()` 对 `role:"system"` 一直返回 `[]`，system 从来没进过
   part/cum → offset 口径（`usage − wire 估算`）自动补偿，不需要改代码。
   对拍证据：同一 20 个会话样本，`scripts/replay-evaporation.mts --core`（仓库内实现）与其内置基线
   **逐字节一致**（`diff -r out-baseline out-core`）。
3. **`sessionFile` = 路径先行、文件内容延迟**：`SessionManager` 构造函数在 create 时就分配好路径，但
   **文件要等首条 user/assistant 消息才写**（`_hasConversation()` 门控 `_persist`）。所以 `sessionFile` 有值
   ≠ 已落盘，判断落盘一律用 `existsSync`（`tools/subagent/runner.ts` 的 jsonlPath 就是这么做的）。
   逆命题同样重要：**新建未发消息的会话改名是合法操作**（`appendSessionInfo` 写内存，首条消息落盘时
   一起写入，不丢名）——不要加 `if (!sessionFile) throw` 这种「尚未落盘」拦截，会给正常路径加假错误。

- **同名工具到底谁赢：`replaceable` 管「让位」，`自定义 < 扩展` 管「优先」**（2026-10-06 修正过一次说法）
  三条机制各管一段，别混：
  1. **`replaceable` 只表达「我让位」**：`omitReplacedExtensions` 里若**任何非 replaceable 扩展**注册了同名
     工具，带 `replaceable: true` 的那个扩展**整个被略过**（与两者谁先注册无关）。所以想让位就标
     `replaceable`，想优先就**别标**（我们自己的扩展一律不标，官方内置三个都标了 —— 将来同名被挤出去的是官方）。
  2. **双方都非 replaceable 时：同组内先注册者赢**（`getAllRegisteredTools()` 里
     `if (!toolsByName.has(name)) set(…)`），后注册的那个报 `Tool "x" conflicts with …` 进
     `extensionsResult.errors`（会显示在扩展面板）。而 inline 扩展恒排在盘上扩展**之后**
     （`loadFinalExtensionSet`: `[...盘上, ...inline]`）——**所以第三方盘上扩展的同名工具天然压过我们**，
     光靠「注册顺序」救不回来。
  3. **`customTools` 是另一层，且能覆盖扩展工具**（agent-session 里 `allCustomTools = [...扩展工具, ...customTools]`
     之后无条件 set）——「内置 subagent 优先」档就是靠它实现的（见 `tools/subagent/mutex.ts`）。
    一句话：**让别人让位 → `replaceable`；让我赢 → `customTools`；注册顺序只在「都非 replaceable」时有意义。**
- **models.json 里任何 key 都是独立 provider 行**：内置 provider 改名（azure）后，用户盘上旧键
  `azure-openai-responses` 仍会被 SDK 当**自定义 provider** 列出来（带着它的 baseUrl），不会自动合并；
  所以 `SettingsService` 里做了读侧归一（旧键条目仍算「覆写内置」），但不主动改盘。

另两条升级期踩到的：

- **版本号不能用 `mod.VERSION` 判**：SDK 的 `VERSION = getPackageDir()/package.json` 的 version，而 `getPackageDir()`
  **优先读环境变量 `PI_PACKAGE_DIR`**。Percho 打包态把它指到 app 内的 pi-package 镜像，且这个变量会
  **被在 Percho 会话里跑的子进程继承**——所以在 Percho 里跑 `npx tsx …`，`mod.VERSION` 报的是随包分发的
  pi-package 版本（如 0.84.3），与 `node_modules` 里真正 resolve 到的 SDK（1.0.4）无关。
  要判版本用 `import.meta.resolve("@earendil-works/pi-coding-agent")` 再往上找 package.json
  （`scripts/smoke-sdk-1.0.mts` 断言 1）。该包 exports 只有 `import` 条件，`createRequire(...).resolve`
  会直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- **`getAllTools()` 不在 `ExtensionContext` 上**：1.0.4 的 `pi.getAllTools()`（返回 `ToolInfo[]`，带
  `annotations` 与 `sourceInfo`）挂在 **ExtensionAPI** 上，`pi.on("tool_call", (event, ctx) => …)` 的 `ctx`
  里没有它 —— 要在工厂闭包里直接用 `pi`（`permissions/extension.ts` 就是这么拿工具声明的）。
  `sourceInfo.path` 的取值：SDK 自带 `builtin:<name>`、Percho customTools `<sdk:<name>>`、
  inline 扩展 `<inline:<name>>`、盘上扩展是文件路径、MCP 服务器工具挂在 `builtin:mcp` 且名字是 `mcp__<server>__<tool>`。
- **手写 `agent.state.messages` 已彻底无效**：1.0.4 的请求上下文由 `buildSessionProjection()` 在
  `prepareRequest` 里逐次重建；`agent.state.messages` 只是个「公开 transcript」缓存（`_refreshFinalizedContext()`
  写它）。撤回（`recallMessage`）里那个绕过 `navigateTree` 的**悬挂用户消息分支**必须自己补
  `session.refreshContext()`——`navigateTree` 末尾内部会刷，不刷则 `session.messages`（UI 的 messageCount、
  `_findLastAssistantMessage()` 驱动的 compaction 判定）停在撤回前 = 幽灵消息。

## 三、构建 · 打包 · 环境

### 关 dev 应用要杀 Electron 子进程，只 `pkill electron-vite` 会留下僵尸占住调试端口（2026-10-06）

症状：重启 `electron-vite dev -- --remote-debugging-port=9224` 后，CDP 连上却拿到 `chrome-error://chromewebdata/`
（`document.body.innerText` 为空、`button` 一个都没有），脚本报「设置弹窗打不开」。
根因：`pkill -f "electron-vite dev"` 只杀了 vite 包装进程，**Electron 主进程/渲染进程是它的子进程，会留下来继续活着**，
而新实例的 devtools 服务器起不来（`bind() failed: Address already in use (48)` + `Cannot start http server for devtools`），
于是 9224 上应答的仍是**旧实例**（它的 renderer 早已死掉，只剩错误页）。
处理：杀干净再起 —— `pkill -f "<repo>/node_modules/electron/dist"`（**不要**用 `pkill -f Electron`，会连带干掉用户的正式版），
`lsof -nP -iTCP:9224 -sTCP:LISTEN` 确认为空；`pgrep -fl Electron` 里除 `/Applications/*` 之外的残留也要清。
自检小抄：连上后先 `location.href`，是 `chrome-error://` 就说明连错了实例，别怀疑业务代码。

**2026-10-07 补第二种形状（更阴）**：端口空着再起，**新实例仍可能绑失败**（没查清谁还占着），此时脚本会**静默连到那个旧实例**上跑完一整轮；等旧实例一死，就剩下一个「进程在、9224/9229 都不监听」的僵尸 —— 后续脚本全报连不上，看起来像「dev 自己崩了」。判据：起完立刻 `grep -c "DevTools listening"` 或 `grep "address already in use" <dev 日志>`，**有后者就说明本轮实例没绑上**，别接着跑。`.local/tmp/layout-freedom/devctl.sh` 的 `start_dev` 已按这个判据加固（起前查端口 + 起后查日志）。

### `npm run test` 偶发失败：backend `channel-watch-extension.test.ts` 的 cursor 落盘竞态（**既有 flaky，2026-10-07 定位，未修**）

症状：`npm run test`（`--workspaces` 串跑两包）偶发红，失败点是
`packages/backend/test/channel-watch-extension.test.ts:936`「catch-up cursor 持久化」—— 第 934 行 `sleep(200)`
后读 cursor，偶尔还没写完就断言。**连跑 6 次失 2 次**（2026-10-07 layout-freedom 终验时由 reviewer 发现；同一次会话里我自己那次恰好绿）。

判定：**与本任务无关的既有 flaky**（未触碰 backend / channel-watch），修它要动 channel-watch 的落盘时序、有回归风险 ⇒ 当时明确**不修**，只记录。

**给下次的用法**：遇到它失败**先单独重跑**该文件确认是这条路，别误判成自己刚改的代码有问题；要根治得把 `sleep(200)` 换成轮询等待落盘（超出当时范围）。

### 取证别用 `asar extract-file`：它把文件解到**当前工作目录**（2026-10-06）

`npx asar extract-file <app.asar> <内部路径>` 会把那一个文件按 basename 丢在**当前 cwd** —— 在仓库里跑就会掉垃圾文件、
还会让 `biome check` 多报一条 warning（实测：`packages/desktop/index-DKGAA7vc.js`，差点被当成漏提交）。
**批量取证一律用 `npx asar extract <app.asar> .local/tmp/<dir>`**（整包解到临时目录，再 grep）。验包照旧按 AGENTS.md：
`npm run build` 之后 `electron-builder`，再 `asar extract` + 按改动关键词 grep `out/renderer/assets/index-*.js`。

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

### Release renderer 构建要显式提高 Node 堆上限（2026-09-21）

症状：本机 `npm run build` 正常，GitHub Release 的 `macos-latest` job 却在 `electron-vite build` 接近输出 chunk 时以 `exit 134` 失败；日志末尾是 `Ineffective mark-compacts near heap limit` / `JavaScript heap out of memory`，堆停在约 2.0GB。Linux/Windows 同一时刻可能仍在正常打包。

原因：renderer 同时包含 Mermaid、KaTeX、Monaco 与大量懒加载语言/chunk，Rollup 在 macOS arm64 runner 上的峰值超过 Node 默认 old-space 上限；这不是 electron-builder、签名或应用运行时内存问题，盲目重跑不可靠。

修复：Release workflow 的 build job 统一设置 `NODE_OPTIONS: "--max-old-space-size=4096"`，让三个矩阵平台使用同一构建口径。遇到类似 `134` 先看日志最后的 V8 GC 段，不要把前面的 Rollup annotation warning 当成根因。失败标签按 `.local/docs/release.md` 流程删远端 tag、让修复提交进入新 tag 后重跑，不能只 rerun 指向旧 workflow 的 run。

### gh CLI 合并涉及 workflow 的 PR 需要 `workflow` scope（2026-09-11 发现）

`gh pr merge --squash` 报 `refusing to allow an OAuth App to create or update workflow .github/workflows/xxx.yml without workflow scope`：gh 的 OAuth token 默认只有 `repo/gist/read:org`，而**凡 merge 会改动 `.github/workflows/` 下文件的 PR，GitHub API 一律要求 `workflow` scope**。修复：`gh auth refresh -h github.com -s workflow`（设备码流程，浏览器确认，一次性）；或网页 UI 手动合。

连带坑（首贡献者 fork PR 死锁）：fork 首次 PR 的 CI 要在 Actions 页面手动 Approve 才会跑，叠加分支保护「要求 branch up-to-date + 检查通过」→ 三者互等死锁，只能 admin 旁路（`gh pr merge --squash --admin`，同样吃上面的 scope 限制）。同步 fork 分支用 `gh pr update-branch <n>`。

## 四、Renderer / React

### Markdown 相对链接会导航 app 主窗口 → 白屏（2026-09-23）

症状：点击助手消息里的 `[报告](.local/docs/html/report.html)` 后，聊天界面整页空白；不是 React #185，也不是会话损坏。`markstream-react` 输出普通 `<a href=".local/...">`，没有 `_blank`；Chromium 把它相对于 `app.asar/out/renderer/index.html`（dev 时是 Vite URL）解析，直接替换主窗口，目标文件不在应用包内于是白屏。原来的 `setWindowOpenHandler` 仅拦新窗口，**不拦同窗口导航**。

修复：`main/window.ts` 用 `will-navigate` 兜底拒绝页面发起的导航；`chat/Markdown.tsx` 委托处理正文锚点，经 `markdown-link.ts` 分类：http(s) 用系统浏览器，本地文件用 `openPath` 按当前会话 cwd 解析（缺 cwd 的相对路径报错，不误用进程 cwd），锚点保留原生页内行为。`setWindowOpenHandler` 同时限制为只外开 http(s)，不能把任意协议交给 shell。路径不存在时显示 toast，窗口不会离开聊天页。

### 鼠标事件 + `:hover`：合成 MouseEvent 不算 hover，要用 CDP 真实鼠标（2026-09-17）

验证 hover 才出现的 UI（如文件行的「⋯」按钮）时，`el.dispatchEvent(new MouseEvent("mouseover"))` 只能触发 React 的 `onMouseEnter`，**CSS `:hover` 不生效**（`el.matches(":hover")` 仍 false），读到的 `opacity` 是 0、截图里永远看不到那个按钮。

做法：用 CDP `Input.dispatchMouseEvent({ type: "mouseMoved", x, y })` 派发真实鼠标移动（元素中心坐标，视口 CSS px），撤开时先 `Emulation.setFocusEmulationEnabled({ enabled: true })`（否则失焦/遮挡态不更新 hover）。可参考临时脚本 `.local/dev-logs/hover-check.mjs`（打印 hover 前后的 `matches(':hover')` + 计算样式并截图）。

**2026-09-19 补（左栏项目行的「⋯」实测，连踩三次才看清）**：

1. **`Page.captureScreenshot` 会把 hover 状态清掉**：截完图 `:hover` 链变空、目标元素的 `pointer-events` 回落 `none`（截图前读到的 `auto` 不再成立）。于是「hover → 截图 → 接着点它」的顺序会**静默落空**（点击落在 `pointer-events: none` 上，不报错也不生效）。
2. **对同一坐标的 `mouseMoved` 不会重算 hover**：截图后想恢复 hover，直接再发一次相同坐标无效 —— 必须**先挪开一点（如 −60px）再挪回来**。
3. `mousePressed` 与 `mouseReleased` 之间**贴太紧偶发不合成 `click`**，验证点击行为时中间留 ~70ms 更稳。
4. **合成 `mouseover` 会污染后续命中测试**：`dispatchEvent(new MouseEvent("mouseover"))` 派发的**合成**事件同样会把 `:hover` 链点亮，而且**不会自己消失** —— 后面用 `document.elementFromPoint()` 量「收起态覆盖层是否挡住正文」时，会误判成「挡住了」（实测：轨道项本来 24px 宽，却报 x=300 命中轨道）。做法：量命中区之前先对**所有**相关元素派发一次 `mouseout`（或等一次真实 `Input.dispatchMouseEvent` 把指针挪走），再读 `elementFromPoint`。
5. **`mouseWheel` 的落点必须真的在目标容器上，且不能被刚弹出的浮层盖住**：右键菜单挂在指针处，紧接着朝“列表中心”派 wheel 很可能落在**菜单**上（菜单不可滚）→ 容器`scrollTop` 纹丝不动，看起来像“滚动了但菜单没关”的假失败。做法：先算出浮层矩形，再在目标容器里挑一个不被遮挡的点，并**同时断言容器 `scrollTop` 真的变了**（否则这条断言本来就不能判定）。实例：`scripts/check-sidebar-unified-scroll.mjs`（旧 `check-sidebar-group-scroll.mjs` 2026-09-29 随统一滚动改造替换）的“滚动后菜单关闭”那一步。

### 嵌套滚动的归属验证 + `overscroll-behavior: contain` 会吞掉滚轮（2026-09-21，左栏分组列表限高）

症状：给一个**不溢出**的滚动容器（`overflow-y:auto` 但 `scrollHeight === clientHeight`）挂 `overscroll-behavior-y: contain` 后，指针停在该区域时**滚轮完全失灵**——该容器滚不动（没内容），**外层祖先也不滚**（contain 把滚动链剪断了）。用户观感：会话列表里“滚不动”，而旁边的项目标题区一切正常。

实测（Electron dev 真实页 + CDP 真实 wheel，探针四组对照）：

| 元素 | 内容 | `overscroll-behavior-y` | 在内层 wheel | 结论 |
|---|---|---|---|---|
| A | 溢出 | contain | 内层滚 | 正常 |
| B | 溢出，已到底 | contain | 内层不动、**外层也不动** | 这就是我们要的不穿透 |
| E | **不溢出** | **contain** | **内外都不动（wheel 被吞）** | 坑 |
| F | 不溢出 | auto | 外层滚 | 对照，证明锅在 contain |

做法：**`contain` 只在“确实会溢出”时才挂，且与该状态标记（如 `data-scrollable`）用同一个布尔值驱动**，别写两套判据（否则探针与真实行为会分叉）。溢出时需要 contain（边界不穿透），不溢出时必须让它为 `auto`（滚轮交给外层）。实测落地见 `components/sidebar/SidebarSessionList.tsx`。

> **后续（2026-09-29，spec `sidebar-unified-scroll`）**：组内限高与嵌套滚动**整体删掉了**（用户反馈「滚到自己组边界还要把指针挪到项目标题上才能继续」），现在左栏只有**一个**外层滚动容器，分组改为「默认 6 条 + 末尾『显示更多』每次 +16」（`lib/sidebar-visible-count.ts`，次数只在内存）。于是上面那套 contain 判据连同 `SidebarSessionList` 的限高/淡出/自身滚动一起消失——本条留作**通用知识**：以后任何时候想给「可能不溢出」的容器挂 `overscroll-behavior: contain`，先想清楚滚轮被吞的代价。新的验收脚本 `scripts/check-sidebar-unified-scroll.mjs` 会直接断言「主体内 0 个自己还能滚的元素」。

**验证滚动归属的三条纪律**（都真踩过）：

1. **不能拿「直接赋 `scrollTop`」冒充滚动**：它绕过滚动链，结论必然假绿。真实 wheel 用 `Input.dispatchMouseEvent({ type: "mouseWheel", deltaY })`（先 `mouseMoved` 到目标上——命中区决定滚动链）。赋 `scrollTop` 只用来把容器**预置**到中部/底部。
2. **落点要落在外层可视区内且不被浮层遮挡**（见上一条鼠标纪律 4）。
3. **读数前等滚动落定**：轮播/平滑滚动是异步的，等“连续两次读数相同”再断言（别固定 sleep 猜时间）。

### CDP 驱动 Electron dev 应用的能力边界（2026-09-19，左栏任务实测）

这几条决定「哪些 UI 行为能用脚本验、哪些必须人工」：

- **`Browser.setWindowBounds` / `Browser.getWindowForTarget` 在 Electron 下未实现**（method not found）。想真改窗口尺寸就用页面里的 `window.resizeTo(w, h)` —— Electron 支持，`window.innerWidth` 会真的变（本任务用它验了右栏 push ↔ 浮层的 1100 / 1000 / 900 三档）。
- **CDP 注入的鼠标事件不会驱动 `-webkit-app-region: drag` 的窗口拖拽**：程序化拖不动窗口（连改造前就存在的顶栏拖拽区也拖不动），所以「无边框窗口的自定义拖拽带还能不能拖」**只能人工确认**；脚本只能验到 `getComputedStyle(el).webkitAppRegion === "drag"` 且元素尺寸非零。
- `Input.dispatchMouseEvent` 坐标是**视口 CSS px**；`Page.captureScreenshot` 的 `clip` 也是 CSS px，输出像素 = clip × DPR。
- **`Page.captureScreenshot` 会打断进行中的指针捕获**（拖动中截图 ⇒ 拖动态卡死），以及合成鼠标的两个其它坑，见「CDP 合成拖拽的两个卡死姿势」（2026-10-07）。
- **CDP 键盘事件要触发原生 `<button>` 激活，必须 `type: "keyDown"` 且带 `text`**（2026-09-29 实测，验「行末『显示更多』按钮能用 Enter 触发」时踩到）：
  Enter → `{ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" }` + `keyUp`；
  只发 `rawKeyDown` 会**照常派发 keydown 事件落到监听器上、但不产生 click**（页面里能收到 `keydown:Enter`，行为却像没按），看着像「按钮坏了」。
  Space 同样要给 `text: " "`。验证键盘可达性时别忘了分两步断言：**能聚焦**（`el.focus()` 后 `document.activeElement === el`，折叠态 `inert` 下应为 false）与**能触发**。

### CDP 合成拖拽的两个卡死姿势：截图打断指针捕获 / 松手坐标跑出视口（2026-10-07，layout-freedom 阶段 1 实测）

做「拖左栏宽度」的验收脚本时，`Page.captureScreenshot` 与放错松手坐标都能把页面**永久留在拖动态**：`is-resizing` 类摘不掉、`body` 光标仍是 `col-resize`、之后再怎么拖都不动（React 组件里的 `draggingRef` 卡在 true，`pointerdown` 直接 return）。当时表现为「同一套断言单独跑全绿、`all` 跑连挂 8 条」。

- **① 截图会打断进行中的指针捕获**：拖到一半调 `Page.captureScreenshot`，之后 `pointermove` 不再送到把手（捕获没了 → 事件落到光标下的别处），`pointerup` 也丢，于是 `finish()` 永不执行。
- **② 松手坐标跑出视口同样丢 `pointerup`**：拖到最左时终点 `x` 是负数（例：从 480 拖到 240，把手在 x=236 → 终点 -4），`mouseReleased` 在视口外没人接。
- **修法（两条都要）**：量测通道**一律不截图**，截图通道挪到最后；每次拖完都在**把手当前位置**补一次 release（有捕获就到把手，没捕获时那个坐标也落在把手命中区里）。验收脚本里 `V2-m` 专门盯这条回归。
- 顺带：**`CSS.forcePseudoState({ nodeId, forcedPseudoClasses: ["hover"] })` 能稳定钉住 hover**（截图不会清掉它，`::after`/`:has()` 都跟着变），所以「hover 态截图」用它而不是反复发 `mouseMoved`（后者对同一坐标不重算 hover，见上一条；且截图前后 `:hover` 链可能被清）。`DOM.querySelector` 的参数名是 **`nodeId`**（写成 `root` 会 `Invalid parameters`）。

### 拖拽只挂 `pointerup` 会在「窗口外松手」后永久卡死（2026-10-07，X3）

**症状**（用户报的）：拖一次左栏宽度后，**整窗光标一直是 `col-resize`**、`is-resizing` 摘不掉、之后**再也拖不动**，要刷新页面才恢复。

**机制**：指针在**窗口外**松手时，`mouseup` 交给的是光标下那个窗口/应用，**页面收不到 `pointerup`**（拖到屏幕边缘继续拖最容易发生）。只监听 `pointerup` / `pointercancel` 的实现就永远等不到收尾信号，拖动态一直挂着。

**修法（三条兜底都要，`SidebarResizeHandle` 里都有）**：

1. **`onPointerMove` 里 `event.buttons === 0` → 收尾**（主路径：用户把鼠标移回窗口内立刻自愈）；
2. `onLostPointerCapture` → 收尾（捕获真丢时的官方信号）；
3. `window` 的 `blur` / `document` 的 `visibilitychange` → 收尾（切窗口/切应用时松手）。

配套：收尾函数要**幂等**（所有路径都走同一个 `finish()`，重复调用无副作用），否则会重复落盘/重复 `setState`。

**验收这个 bug 的坑（重要）**：

- **CDP 无法忠实模拟「OS 没送 mouseup」**：`Input.dispatchMouseEvent` 的 `buttons` 会直接改 Chromium 的按键状态，所以合成事件里 Chromium 可能自己补发 `pointerup`，让修复前的代码也「看起来正常」。
- 所以**别用「手改成 disabled 的版本」当对照**（我这么干过，结论一度自相矛盾）—— 要用**真正的上一个 commit** 当对照：`git show HEAD:<file> > <file>` 切过去跑一遍断言，修前应全红、修后应全绿。实测：修复前 V2-q/r/s/t 四条全红 + review 的 `repro-lostup.mjs` 显示「仍卡着 / 拖不动」。
- 另注意 CDP 的 `button` 与 `buttons` 要一致：`type: "mouseMoved"` 且 `buttons: 0` 时 `button` 必须给 `"none"`，给 `"left"` 的话 Chromium 会当成「左键仍按着」（`event.buttons` 还是 1），于是 `buttons === 0` 这条兜底**测不出来**，很容易误判成产品 bug。

### dev 里 HMR 会让 store 订阅冻结：验收前要硬重启（2026-10-07，差点误判）

**症状**：改了代码、HMR 热更后，界面上某些值**再也不跟随 store 变化**了 —— 例：`ui-state.json` 里 `sidebarWidth` 是 280，页面上侧栏却一直是 320（连拖动都不动了）。看起来像新写的派生逻辑坏了。

**诊断手法**（一次定位）：从 DOM 拿 React 自己的 props/state，和文件/真实输入对账 ——

```js
const el = document.querySelector(".sidebar");
const pk = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
el[pk].style; // => {"--sidebar-render-width":"320px"} ← React「最后一次渲染」给的值
```

再配合 `git show HEAD:<file>` 切回上一个 commit 跑同一段脚本，就能区分「代码问题」与「热更后运行时状态坏了」。

**结论/纪律**：**验收脚本一律在硬重启（`stop_dev` → `start_dev`）之后跑**，别在热更过的实例上得结论。`devctl.sh` 已按这个用。（同类教训：HMR 之后 `ResizeObserver`/订阅这类「effect 只在挂载时建立」的东西最容易出这种假象。）

### 比列宽更宽的内容会「溢出吃 pointer 事件」：截图看不出来的点击死区（2026-10-07，X2）

**症状**：左侧栏拖宽到 480 后**再想拖回来就拖不动了**（把手抓不住）；同一区间里行末的「＋ / ⋯」等控件也点不到。截图完全正常 —— 溢出的那块要么是透明的、要么本来就被不透明的左栏盖在下面看不见。

**机制**：聊天页空态的 logo 块是固定 **748px 居中**，聊天列窄于 748 时它向**两侧**溢出；DOM 里它在左栏之后 ⇒ 溢出的透明矩形**照样参与命中测试**，把左栏右缘一整条（侧栏 480 时实测 **82px**）变成点击死区。触发区不极端：窗口宽 < 748 + 侧栏宽 就中招（1064 的窗口下侧栏 > 316px 就开始），而应用默认窗口 1100 ⇒ 拖到约 388 就会踩到。

**诊断（可复用）**：

- 最直接：`document.elementsFromPoint(把手中心)[0]` 打出的是**聊天列里的 `svg`**（logo）而不是把手 —— 一眼定位。
- **别用截图/像素对比判这类问题**：遮挡在像素上不可见。要判「有没有死区」就用 `elementFromPoint`/`elementsFromPoint`（浏览器自己的命中测试），或真的合成一次点击。
- 扫描时的坑：`getBoundingClientRect()` 非零 ≠ 可见 —— 折叠分组（`grid 0fr` + `overflow: hidden`）与滚动出可视区的行，其子元素 rect 仍是正常尺寸却**根本不参与命中**，会被误判成「被遮挡」。判据要加上「未被 `overflow != visible` 的祖先裁掉」的预筛（`scripts/verify-layout-freedom.mjs` 的 HIT_STACK 就是这么写的）。

**修法**：给左栏 `z-index: 1`（它已是 `position: relative`）。视觉零变化 —— 栏内无 fixed/portal、根级浮层（设置弹窗/Toaster）在更外层节点，前后对比截图只有 173 px、单通道 ≤ 5/255 的 wordmark 抗锯齿差异。

**回归断言**：`scripts/verify-layout-freedom.mjs` 的 `V2-n`（把手中心最上层就是把手）、`V2-o`（栏内可见控件中心命中都落在栏内）、`V2-p`（拖到 480 松手后仍能重抓拖回）—— **修前全红、修后全绿**（把 `z-index` 临时改回 `auto` 实测过）。

### 左栏把手偶尔命中不到 / `verify-layout-freedom` 的 V2 断言一片红（2026-10-07，**成因未定位**、常态 43/0）

**症状**：`scripts/verify-layout-freedom.mjs` 的 `V2-n`（把手中心最上层就是把手自己）与 `V2-p`（重抓把手拖回）一片红；
`elementFromPoint(把手中心)` 拿到的是 `div.edge-fade`（左栏滚动容器）而不是 `hr.sidebar-resize-handle`。

**一个已被实测否掉的猜想（勿再照抄）**：当时猜是「`.edge-fade` 滚到边界时加 `mask-image` ⇒ 创建层叠上下文 ⇒ 按 DOM 序压在绝对定位把手上」。
**复审方补测（2026-10-07）把触发条件强行凑齐后否掉了它**：往左栏注入内容使列表可滚（`scrollHeight 1125 / clientHeight 564`）、
`data-fade-bottom="true"`、`mask-image ≠ none`，此时 `elementFromPoint(把手中心)` **仍是 `hr.sidebar-resize-handle`**。
原因：`.edge-fade` **没有任何 `position` 规则**（是 `static` 流内元素），它按流内步骤绘制，而绝对定位的把手在 step 8，天然在它**之上**；
要真把把手压住，容器得先进入 step 8（自身成为定位元素），当前 CSS 里不存在这个条件。
（对照 X2：那次是「聊天列溢出盖住整条左栏」，修在 `.sidebar` 的 `z-index`；**是否同为栏内竞争，目前无证据**。）

**已知的两个方向（供下次复现时先查）**：
1. 那一刻滚动容器是不是定位元素（`getComputedStyle(容器).position` 不是 `static` ⇒ 它就落到 step 8，而它在把手**之后**入树）；
2. 把手的命中区高度是不是退化为 0（`hr` 与 preflight `height: 0` 那一条，见本文件），或在 `{!collapsed && …}` 下压根没渲染。

**触发条件很窄，所以时有时无**：验收当时 dev 的左栏（样本会话 + 展开的分组）刚好能复现 → 12 条红；
把 dev 硬重启、回到常态 → `verify-layout-freedom.mjs all` **PASS 43 / FAIL 0 / SKIP 1**，
此刻左栏 `scrollHeight == clientHeight`、`mask-image: none`、把手命中正常。

**结论与建议**：现象真实，但**成因未定位**（不是本次「自定义字号」引入的：左栏/把手相关代码这次一行未改；也解释不了「只在该实例上红」）。
若下次真复现，**先把那一刻的 `getComputedStyle` / rect 存下来**（那个实例的状态一旦消失就再也查不了——本次就是这样）。
真要加固，一行即可：`.sidebar-resize-handle { z-index: 1 }`（把手是 `.sidebar` 的直接子元素，抬一层就够）。（本次**未改**，因为它属于左栏拖拽特性。）

**顺手记两条验收纪律（这次我因此误报过一轮「既有 bug」）**：
1. **CDP 验收前停 dev → 硬重启**：长期跑着的实例状态已被历次脚本改过（store、inline style、滚动位置、HMR），红不一定是产品问题。
2. **单点探针不能替代跑整脚本**：`elementFromPoint` + 临时摘一条 CSS 只能证明「那一刻」的因果；判定前至少要在**干净环境复现一次**，否则写成「疑似，待干净环境复核」。

### Tailwind preflight 的 `hr { height: 0 }` 会盖掉 `top: 0; bottom: 0`（2026-10-07，拖拽把手命中区高度 0）

给左栏把手用 `<hr>`（图它的隐式 role = `separator`）时写了 `position: absolute; top: 0; bottom: 0; width: 8px`，**命中区高度却是 0**：Tailwind preflight 给 `hr` 定了具名 `height: 0`，具名高度优先于 `top/bottom` 的约束解析（over-constrained），于是「撑满父容器」失效。CDP 合成鼠标落在它上面根本命不中（表现为「拖不动」）。**修法：显式 `height: auto`**（顺手把 preflight 的 `margin`/`border-top-width` 也清掉）。

### 脚本复位 inline style 别用 `cssText = ""`（2026-10-07，shoot-sidebar 踩到）

`shoot-sidebar.mjs` 的 RESET 原本 `sb.style.cssText = ""`。侧栏宽度改成由 React 写在 `.sidebar` 上的 `--sidebar-render-width` 驱动后，这一句会把**变量一起抹掉**——脚本跑完侧栏掉回 CSS 兜底值 240，直到下一次 React 渲染才纠正（表现为「跑完脚本界面宽度不对」）。修法：按属性 `removeProperty("width")` / `removeProperty("transition")` 精确清理。

### monaco 只在创建编辑器时应用 `options`：换字号必须重建代码块（2026-10-07，自定义字号阶段 3）

**症状**：改了「代码字号」档位后，monaco 代码块的字号/行高**纹丝不动**（`.view-lines` 上的 inline `12px / 18px` 不变），而同一档位下内联 code / diff 表都跟着变了。

**机制**（库内部实测，`node_modules/markstream-react/dist/*.js`）：

1. **参数是从 `codeBlockProps` 传进去的（这是当前生效的路径）**：内置代码块被渲染成
   `P(Pn, { …, monacoOptions: codeBlockThemes?.monacoOptions, …, ...omit(codeBlockProps, ["langs"]) })`
   —— `codeBlockProps` 的展开在 `monacoOptions` **之后**，所以 `codeBlockProps.monacoOptions` **覆盖** `codeBlockThemes.monacoOptions`（后者对应 prop `codeBlockMonacoOptions`）。
   即：本项目把 monaco 选项写在 `codeBlockProps.monacoOptions` 里是对的；两个 prop 都在 `.d.ts` 里，极易看岔方向。
2. **`fontSize` 只在编辑器创建路径里应用一次**：全库 `updateOptions` 只有 3 处 —— ① `automaticLayout` 变化时；② 编辑器创建路径 `updateOptions({ fontSize: p, automaticLayout: false })`（即创建时那一次）；③ 内置「字号 +/-」按钮路径 `updateOptions({ fontSize: Be })`（取决于开关，本项目 `showFontSizeButtons: false` 关掉了）。
   ⇒ 运行时**没有**任何东西会跟着 props 重算 fontSize；只换 `monacoOptions` 对象身份（哪怕 `useMemo`）对**已挂载**的编辑器无效。
   顺带：③ 也说明「对活编辑器 `updateOptions({ fontSize })` 是安全的」—— 将来若重建代价不可接受，可以走这条路（需要拿到 editor 句柄，库没暴露）。

**修法**：`<MarkdownRender key={`code-font-${codeFontSize}`} …>` —— 换档位时重建该消息的 markdown 子树。

**代价（实测，真实会话 9 个 monaco / 42 行可见）**：切档到全部生效 **98–131ms**，期间**最长帧间隔 50–58ms**（约掉 1 帧）；对照：只改界面字号（不重建）**47–55ms / 42ms**。
另两条连带影响：① 卡片内的局部视图态会被重置（如 mermaid 卡的「源码/预览」切回预览）；② 内容高度变化会让贴底的滚动位置位移（实测 scrollTop +250px，视觉上底部保持贴底，不是跳位 bug）。

**查证手法（本次被骗过一次，记一笔）**：**在压缩产物里找「某方法有没有被调用」不能用 `rg "updateOptions\("`** —— minified 里是 `a.updateOptions)||r.call(a, …)`，属性访问后面跟的是 `)` 而不是 `(`。要 `rg -o "updateOptions" <bundle>` 再逐个看上下文（第一版结论「库里没有任何 updateOptions 调用」就是这么来的）。

**另一个容易踩的坑**：monaco 的 `.monaco-scrollable-element.scrollWidth` 是 **16777214** 的占位值（内部最大宽 hack），拿它判「有没有横向溢出」会永远为真；要判横向滚动请读它自己的 `.scrollbar.horizontal` 的 computed `visibility`。

### CDP 截图不绘制滚动条：只能力槽宽（2026-09-29）

`::-webkit-scrollbar` 宽度改小（8px → 4px）后 CDP 截图里**看不到任何滚动条**，一度以为改动没生效。做了对照：临时往页面塞一个 `overflow-y: scroll` + `thin-scrollbar` 的 div，槽宽量到 4px，**截图里同样不画**——所以这是截图/合成器不绘制滚动条层，不是改动问题（与 headless 画板那次同一个坑）。判据用 `el.offsetWidth - el.clientWidth`：带类 4、去掉类 8，两次都在真机（dev 窗口）上量。

### CDP `clip.scale` 是**再**乘一次 DPR：输出像素 = clip × scale × DPR（2026-09-29）

比像素做视觉核验（强度/亮度/对齐）时踩过：`clip: { width: 300, height: 112, scale: 2 }` 在本机（DPR 2）拿到的是 **1200×448**，即 4x——按 2x 反推 CSS 坐标会让取样带整体偏移，看上去像"遮罩没生效"。要么统一 `scale: 1`（输出 = 2x，CSS 像素 × 2），要么把换算写成 `clip × scale × devicePixelRatio` 并断言一次实际尺寸。

顺带一条可比对的核验手法：**同一滚动位置、同一 clip，只切被测属性（如 `dataset.fadeTop` 置 false），逐行取均值比亮度差**——比人眼看截图可靠（实测淡出带内 +24.9，带外 +0.0）。

### `.edge-fade` 的 mask 会把容器内 fixed 浮层的绘制裁在容器盒里（2026-10-06，设置弹窗登录框事故）

**症状**（用户报的）：设置 → 模型 → 点某 provider 的「登录」，登录弹窗只显示右半边（左边被设置弹窗的左导航「遮住」），
而且**蒙层只盖住右侧内容列**——设置顶栏、左侧导航都不跟着变暗。
最迷惑的是：`getBoundingClientRect()` 量出来蒙层 **= 整个视口**（0,0,innerWidth,innerHeight），`position:fixed` 也没跑偏。

**根因**：要理解 mask 的作用域 —— **mask 作用于元素及其整个绘制子树**，且蒙版图像只覆盖该元素自己的盒子；
元素盒子之外的绘制一律被 mask 掉（等于被裁）。设置弹窗右列这次加上了滚动边界淡出（`.edge-fade` + `use-edge-fade`），
滚动时容器带上 `mask-image: linear-gradient(...)`；而 `LoginDialog` 是挂在 `ProvidersPanel` 里的
`fixed inset-0` 蒙层 —— 铺满视口的矩形，**只有落在容器盒内的那部分画得出来**：
右列那一块 = 蒙层（所以只有它变暗），卡片超出容器盒的左半边 = 直接被裁掉，露出下面不透明（未被 mask）的左导航。
注意与 `filter` / `transform` 的差别：那两者会成为 fixed 的**包含块**（rect 就错了），mask 不改包含块，**rect 是对的、只有像素不对**。

**修复**：fixed 浮层一律 `createPortal(..., document.body)`（本项目既有约定：ConfirmDialog / ContextMenu /
RenamePopover / ImagePreview 都是这么做的，`LoginDialog` 漏了）。z-index 上 `z-[60] > 设置弹窗 z-40` 也对上了。

**两道免复发的守卫**（`.local/tmp/check-settings-chrome.mjs`，改前跑会红、改后绿）：

1. **结构不变量**：任何 `getComputedStyle(el).maskImage !== "none"` 的 `.edge-fade` 容器内，
   不得存在 `position: fixed` 后代（改前 `fixedCount=1` 精确点名了那个蒙层）；
2. **像素断言**：开/关登录弹窗各截一张全窗图，采样「设置顶栏」与「左导航」两点，亮度都必须变暗
   （改前 Δ=0/0 —— 蒙层根本没盖到；改后 Δ=-37/-46）。

**连带教训**：写这类像素对比脚本前，先关掉上一次跑残留的浮层（弹出的框会一直留着并串进本次截图，
我曾据此误判过一次）；采样点用 `--points` 模式直接读像素，别靠肉眼看截图。

### Tailwind 4 的 `rotate-*` 走 CSS `rotate` 属性，不是 `transform`（2026-09-19）

症状：验证脚本用 `getComputedStyle(svg).transform` 判断「展开箭头有没有转 90°」，拿到 `"none"`、推断「样式没生效」——但截图里箭头明明是朝下的。

原因：Tailwind 4 的 `rotate-90` 编译成 **`rotate: 90deg`**（新式独立变换属性），`translate-*` / `scale-*` 同理，所以老的 `transform` 读写看不到它们；`transition-transform` 也会展开成 `transition: transform, translate, scale, rotate`。

做法：读 `getComputedStyle(el).rotate`（或直接断言 `transitionProperty` 含 `rotate`）。**同理**：判断元素是否位移别只看 `transform`，`translate-*` 也一样。

### 别手拆 React 管理的 DOM：`removeChild` 暴雷（含 portal 浮层）（2026-09-19）

症状：脚本里为了「关掉菜单」写了 `document.querySelector('[role="menuitem"]').parentElement.remove()`，几秒后整页被错误边界接管，报 `Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node`（Percho 界面显示「界面出现异常」），于是后续所有量值全部落空、极易当成自己刚改的代码把页面治崩了。

做法：**只走组件自己的关闭路径**（`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`、或派发 `pointerdown` 到 body 让点外关闭生效）。同理：React portal（右键菜单 / 确认弹窗 / toast）里的节点一律不手动增删；要重置页面直接 `Page.reload`。

**2026-09-21 补（反方向的同类坑：命令式改 JSX 已声明的属性）**：想在滚动中把状态写成 DOM 属性时，如果那属性**在 JSX 里声明过**（如 `data-fade-top={...}`），再用 `el.dataset.fadeTop = ...` 命令改，**React 下一次重渲染会把它冲回声明值**，而你的 effect 依赖没变、不会重跑——于是属性停在错误的旧值上（或初值上），肉眼与脚本都难归因。两条出路：① 属性**完全不在 JSX 出现**，由 effect 独占增删（`delete el.dataset.x` 清干净）——本次采用；② 属性交给 React 独占，resize/scroll 推进 state（会逐次 re-render，列表类组件别选）。注意：React 不会动它不认识的属性，所以“在 JSX 里没声明”的写法是安全的。

### 删除正在跑的会话会在后端留 stale ctx 报错（2026-09-20，既有现象）

症状：对一个**正在跑 agent** 的会话执行「删除会话」，后端日志会出现 `context-evaporation` / stale ctx 一类报错。原因：`deleteSession` = `closeSession()` + 删文件，**不先 `abort()`**（内存策略那轮核实过：`PiBackend.deleteSession` → `disposeSession` + unlink，没有 abort 步骤）。后果仅限日志噪音（会话确实被删掉了），但排查别的上下文蒸发问题时会误导。

现状：**属既有行为、未修**（删除是用户明确意图，行为本身是对的；缺的是先 abort 再 dispose 这一步）。要修的话：删除路径显式 `await entry.session.abort()` 再 `disposeSession`。

### 顶栏内容 = 置顶表驱动，别从 tabs 里筛（2026-09-19）

症状：把「顶栏只显示置顶会话」实现成 `tabs.filter(s => pinned.has(s.id))` 后，用户会碰到 **左栏会话行有图钉、顶栏却没有那个胶囊**（我验收时真踩到）：只要那个会话的 tab 被叉叉关过（或本次启动没恢复它），它就不在 `tabs` 里，于是被悄悄藏掉——“置顶”看起来失效了。

做法：置顶表的 id **逐个到 `tabs` → 历史（`allSessions`）里取 meta**（tabs 优先，名称/状态更新），取不到才跳过（会话已删）；点击时 `openSession` 一条路兼容“已打开就切 / 未打开就从历史开”。同理：叉叉（关 tab）只在“确实有 tab”时才该显示，否则就是假入口。

本轮同时删掉了旧模型里“置顶顺带把会话挪到 tabs 最前”这套副作用（顶栏顺序改由 `pinnedSessions` 表达，`reorderSessions` 已无引用，一并删）。

### 空数组不能同时当「未初始化」与「有效空值」（2026-09-20，sidebar-draft-picker-fixes）

症状：左栏「当前项目是最后一个展开组时，把它折了会立即又展开」；切会话/重渲染也会“自己弹回来”。

根因：展开态只有一个字段 `expandedGroups: string[]`，而推导层把它写成 `expandedGroups.length > 0 ? expandedGroups : defaultExpandedKeys`——**`[]` 被当成“用户还没开合过”**。于是用户真把最后一组折了（存 `[]`）后，下一次派生又回退到默认集（当前会话所在组），折叠永远存不住。同类陷阱：将来任何一个“空集合 = 无操作”的存储字段都会重踩。

修法：**加显式的“用户动过”位**（`expandedGroupsTouched`，shared UiState + main normalize 迁移 + store 单补丁原子写两字段）——`false` 才走默认推断，`true` 时 `[]` 就是“全部折叠”。迁移规则：旧文件缺该字段时按现有记录是否非空推断（非空 ≈ 已操作）。

顺带一并修掉的同源问题：`toggleExpandedGroup(current, key, defaults)` 旧实现用 `current.length > 0 ? current : defaults` 当起点，**全部折叠后再点开一个组会把默认集（当前会话所在组）一起拉出来**——起点同样必须由 touched 位决定（参数化后补了用例）。

### absolute 弹层越界 + autoFocus = 整页横向偷跑（2026-09-20，sidebar-draft-picker-fixes）

症状（用户报）：打开 composer 的模型选择器后，**整页向左偏移**，左栏与顶栏左侧按钮被挤压/裁切（实测顶栏最左按钮 left 从 80 被推到 72，窄窗口 44.5）。

量测（dev + CDP，1100/900/700px 窗口均复现）：弹层 `left-0 w-72` 从按钮左缘向右展开 → 面板右缘越出视口约 12px；搜索框 `autoFocus` 后 Chromium 会把聚焦元素滚进视口，**被滚的容器是 `#root`**（`#root.scrollLeft` 0 → 8/35.5）。`html, body, #root { overflow: hidden }` **拦不住程序性滚动**——它只挡用户滚动，所以“有 overflow:hidden 就不会跑”是错的假设。

修法：弹层改成贴着触发按钮的**另一侧**展开（`right-0`），让矩形落在视口内（659→947 < 1100）；修后三处根 scrollLeft 恒 0、左栏宽恒 240、顶栏按钮零位移。若矩形仍放不下，才考虑 `place-menu.ts` 那套“先渲染再量、越界翻转”的浮层定位（issue #55 方案），**不要只加 overflow:hidden 或靠 clip**。

**量测三纪律**（本次都踩过，会造成假绿/假红）：

1. **selector 要限定作用域**：composer 里 tooltip 也是 `div.absolute.bottom-full`（宽 157 vs 弹层 288），全局 `querySelector` 会把 tooltip 当弹层面，得出“在视口内、没滚动”的假绿；必须取**触发按钮的兄弟节点**。
2. **扫多档窗口宽**：1100px 下越界 11.8px 恰好勉强可看，900/700px 才明显；只看默认尺寸容易放过。`window.resizeTo(w,h)` 在 Electron dev 里可用（`Browser.setWindowBounds` 未实现）。另外 mvp 窗口 `minWidth: 640`，扫到 700 就够了。
3. **侧栏行不能按标题分辨**：分组头（`h-[34px]`）与会话行（`h-[31px]`）**都带 title 且文字相同**，按文本找会把分组头当会话行（本次真误点了分组头 → 把项目组折了 → 误判“draft 没进左栏”）。会话行用 `className.includes("h-[31px]")`；两者都拿不准时，优先拿 store 状态（页面内 `await import("/src/stores/*.ts")` 拿到的是应用在用的同一个模块实例）来交叉验证，别只信 DOM 推断。

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

### 右侧栏 width push 动画导致聊天区逐帧重排（2026-09-21）

**症状**：新会话页打开/收起变更栏很顺，有消息内容的会话明显掉帧；内容越长越明显。

**根因**：右栏原来在同一 flex 行里做 `width: 0 → min(420px, 38vw)` 的 420ms push 过渡。每个动画帧都会改变聊天列宽度，迫使 Markdown 重新换行和整列布局；`MessageList` 的 ResizeObserver 又会在跟随底部时逐帧调用 `scrollTo`。实测一次开栏约 52 次布局、42–50 次贴底滚动；隐藏 diff 内容改善很小，强制脱离布局后 LayoutDuration 从约 37–43ms 降到 3–5ms，说明瓶颈不在 diff 行本身。

**修复**：右栏统一为绝对定位浮层抽屉，宽度固定，进退只动画 `transform/opacity`；聊天列完全不改宽。点击聊天区不自动关闭，保留顶栏开关、面板关闭按钮和 Esc，便于边看消息边核对变更。不要用 `max-width`、grid 列宽或另一种尺寸属性代替 `width`——它们仍然逐帧触发布局；要丝滑必须让运动留在合成层。

### 关窗拦截必须留「渲染进程卡死」兑底：`unresponsive` 靠不住（2026-09-21，issue #71）

背景：Windows 点 ✕ = 退出（微软惯例，不改），只在退出前弹一句「退出后正在跑的任务会终止」让用户自己决定。三条都是踩出来的：

1. **`webContents.on("unresponsive")` 不能当「渲染进程卡死」的判据**：renderer 里投一个死循环（CDP `Runtime.evaluate` 跑 `while(true){}`，回包永不到）后等 20s，主进程**没收到任何 `unresponsive` 事件**（macOS 实测；`render-process-gone` 只管真崩溃）。只信它的话，卡死时 `close` 被拦下却没人弹窗——窗口从此关不掉，只能上任务管理器，**比误点退出更糟**。
2. **正确做法 = 「上屏回执 + 超时放行」**：main 发 `app:quit-requested` 后起 1.5s 计时，renderer 的弹窗组件在 `useEffect` 里回一条 `app:quitDialogShown`（放在组件而非事件订阅处：提交后才有 DOM，才是真「上屏」）；回执到了就撤计时交回用户，超时就 `quitting = true; app.quit()` 退回原行为。实测：卡死 → 1.5s 后自动退出，不会卡住。
3. **还要一个「没人接管」的默认放行**：renderer 挂载时才置 guard（`app:setQuitGuard`），未置位（页面还没挂上 / 崩成错误页）就照旧关窗即退；弹窗组件必须挂在 `AppErrorBoundary` **外面**，否则 App 崩成错误页时它一起没了，又变成「拦下来但没人弹窗」。

验证手法（本机 macOS，靠两条临时改动模拟 Windows 分支）：main 里 `process.platform` 判断临时放宽 + 加个临时 IPC `test:closeWindow` 走 **main 侧** `win.close()`—— **不要用 renderer 的 `window.close()`**（它会直接销毁窗口，不走 `close` 事件，见上一节）。脚本留档 `.local/verify/quit-confirm-check.mjs`。另外：`PERCHO_QUIT_TEST_CLOSE_MS` 那类「到点自动关窗」的临时计时器必须在 `ready-to-show` 之后才起，否则窗口还没显示就关了，看着像「拦截失效」。

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

### dev 改 store 后「界面没反应」：HMR 重建了 zustand 模块实例（2026-09-28，session-workspace 阶段 3）

症状：dev 里改完 `stores/*.ts` 继续手验，**点了会话说「不出胶囊」**、点 × 没反应、组件像是拿到了空状态 —— 但代码与单测都对，重启 dev 后一切正常。

原因：Vite HMR 让 store 模块**重新求值**，于是产生了**新的** zustand store 实例；旧实例上已经写进去的状态（成员表、`activeSessionId` 订阅等）留在旧闭包里，而 React 组件被新模块重新渲染后订阅的是新实例 → 看起来「状态凭空丢了」。订阅式接线（`useSessionsStore.subscribe(...)` 这类模块级副作用）也会被重新注册一遍。

做法：**任何 store/接线改动后的手验，先整体重启 dev（杀掉 electron-vite 与 Electron 再起），不要在 HMR 后的页面上判断功能对错**；CDP 验收脚本也应在重启后的干净页面跑。判断当前页是不是被 HMR 污染过：看 dev 日志有没有 `hmr update` 记录（或直接重来一次）。

### 内存 meta 覆盖历史 meta = 排序键漂移到 createdAt，行会“自己跳”（2026-09-20，sidebar-session-switch-stability）

症状：点开左栏某条历史会话，那一行**当场移到别处**（项目里第 3 行 → 第 22 行）；等它被自动卸载（或关掉再开另一个），又跳回原位。用户描述成“点一下行就乱跳”。

根因：左栏数据来自两份来源合并且**同 ID 后者整体覆盖前者**——磁盘历史（有完整 `modifiedAt`）与内存活跃会话（当时只有 `createdAt`，且是文件 birthtime）。合并且丢掉 `modifiedAt` 后，排序键 `modifiedAt ?? createdAt` 就从「最后活动时间」掉到「当时才诞生的 birthtime」——于是行位置随“打没打开”变。

对策：

- 同 ID 合并要分字段：运行态字段（name/model/active/messageCount）以内存为准，但 **`createdAt` 取历史权威值、内存缺 `modifiedAt` 时保留历史值**（`lib/sidebar-groups.ts` 的 `mergeSessionMeta`）；
- 更根上的一步是**让内存 meta 自己带正确的 `modifiedAt`**（后端 `toMeta` 改从 header/entries 算，见二 · birthtime 那条）——两层都要，上游漏一个字段下游不该跟着错；
- 回归验收不要只看“值对不对”：**记录点击前后这一行的 `top` 与序号**（CDP 读 `[data-session-id]` 顺序即可），比对比快照更能发现“位置漂移”。

### 异步导航必须 latest-wins（令牌 + 共享 open pipeline）（2026-09-20，sidebar-session-switch-stability）

症状：快速点两行（或点一行再切回已加载的会话），界面**停在先点的那一行**——第一次点击的 `openSession` 后到，把刚切走的 `activeSessionId` 又写了回去；极端情况下还会把 `cwd` 一起带回旧项目。

根因：所有导航入口都是 `await IPC → set({activeSessionId, cwd, lastUsedAt})`，没有任何措施区分“这是不是我最后一次点击带来的结果”。更阴的一点：`createSession` 不返回新会话 id、调用方改写 `activeSessionId` 取回它（为了拿权限模式/发首条消息）——一旦 latest-wins 生效，调用方就会拿到**别人的** sessionId（消息和权限模式发错会话），所以「改导航语义」必须同步审计所有调用点。

对策：

- 导航动作**入口就领**一个进程内单调令牌（不能等 IPC 回来才领，否则表达不了点击顺序）；异步返回时只有令牌仍是最新才写 `activeSessionId/cwd`，过期的只落数据（meta 进 tabs、bundle 装载）；同步切换（`switchSession`）领号即可瞬间作废所有在飞的 open/create/fork；
- **同一文件共享一个 open pipeline**（模块级 in-flight Map，key = 规范化路径）：双击只发一次 IPC、失败只 toast 一次、settle 后必清 key（否则失败后永远重试不了）；bundle 装载再按 sessionId 去重（open 完成时 meta 会先落进 tabs，用户再点那一行走的是懒加载，两条路会撞车）；
- **异步创建/分叉要把新 id 作为返回值交给调用方**，禁止“创建完读 active 拿 id”；
- 自动卸载（GC）的“关完成”要**复检 active**：关的过程中用户可能刚好选中了这个会话（判定“可卸”时它还不是 active），此时应当**重新打开后端会话**而不是把它从 UI 抹掉——只重建 backend、不重载磁盘历史（否则 idle transcript 会被历史快照覆盖），不写 `activeSessionId`、不领新令牌。

### 会话目录写穿：左栏「行存不存在」不能依赖内存（2026-09-21）

症状：新建的会话先好好地待在左栏，过一阵（切走到别的会话后）**突然消失**；点「＋」进新会话页后又出现。顶栏置顶胶囊如果指着它，也会一起没。

链路（`main-<日期>.log` 实证，含精确到秒的复现）：

1. 左栏行的数据源是「磁盘历史快照 + 内存会话」合并；而磁盘历史（`projects.allSessions`）**只在进新会话页（`EmptyState` 挂载）时整表重拉**。
2. `17:19:05` 用户点「＋」→ 拉快照（**必然早于它接下来要建的那个会话**）；`17:20:35` 首条消息才建出会话 → 它只活在内存里，靠合并撑着左栏那一行。
3. `18:11:26` 用户切走 → 它不再是 active → 内存策略（GC）下一轮立刻卸它（`lastUsedAt` 只在「打开/切到/新建」打点，发消息不打点，所以时间戳一直停在 17:20，一离开 active 就命中 5 分钟超时）→ 内存里没了、旧快照里也没有 → **行凭空消失**。日志里就一行 `session closed <id>`，无任何删除语义。
4. `18:18:43` 再点「＋」→ 又拉一次快照 → 行回来。

对策（已落地）：**目录是存在性的唯一来源，会话一进内存就写穿进去**。`stores/projects.ts` 底部一处 `useSessionsStore.subscribe`（会话一进内存就补进目录，**只补缺不覆盖**，磁盘权威的时间字段不被内存 meta 盖掉）+ `load()` 结尾再补一次（`0` 消息会话还没有会话文件，重拉的快照必然没有它）。内存 `sessions` 自此只负责运行态；GC 卸载 = 只撤运行态，不撤存在性。单测：`stores/projects.test.ts` 的「会话目录写穿」四例（含「卸载后左栏行仍在」）+ `lib/sidebar-groups.test.ts`。

**名称也要写回目录投影（2026-09-22）**：新建会话的首份 meta 尚未命名，写穿目录后才由首条用户消息触发 `session_info_changed`。若事件只更新内存 `sessions`，会话在内存时标题正确；GC 卸载后只剩目录里的 `name: undefined`，`sessionTitle()` 就回退到 cwd 末级名（本次为 `percho`）；再次打开后内存 meta 从磁盘读到正确名称，于是标题又变回首条消息，形成反复切换。修复是在事件桥同时更新 `sessions` 与 `projects.allSessions`；显式重命名原本就采用同样的双投影同步。回归用例覆盖「自动命名写回后 GC 卸载仍保留名称」。

连带两个教训：

- **推导链条里任何一环「旧」，整条结论都不可信**：spec 里曾写着「左栏列的是磁盘历史，所以卸载不会让任何列表缺项」——这句话在快照新鲜时成立，而快照并不保证新鲜（`session-memory-policy.md` §1 已标注修正）。审查这类断言时要问「这份数据的**新鲜度**由谁保证」。
- **renderer 模块图不许有环**：写穿用一个模块级订阅，立刻在「`sessions` 先进」的入口（三个 store 单测）报 `Cannot read properties of undefined (reading 'subscribe')`——环 `projects → sessions → ui-preferences → sidebar-groups → projects` 让 `projects` 的模块体在 `sessions` 未求值完时执行。环的成因只是 3 行纯函数 `toggleInList` 挂在 `sidebar-groups` 上（已拆成叶模块 `lib/toggle-in-list.ts`）。防线：`src/renderer/src/import-cycles.test.ts` 扫全图断言 0 环（本仓当时为 0，含 `import type`）。

复现手法（可复用）：dev 实例 + CDP 直接驱 store 走真实入口（`.local/dev-logs/repro-session-catalog.mjs`）：`createSession()`（真实 promotion）→ `activateNewSessionDraft()` 切走 → `unloadSession(id)`（GC 真实入口）→ 断言 `inMemory=false` 但 `inCatalog=true` 且 `document.querySelector('[data-session-id=…]')` 仍在。**侧栏按组渲染，断言前要先展开该会话所在项目的组**（`setExpandedGroups([...groups, cwd])`），否则“行不在 DOM 里”是假阴性。

### 打开期间流式事件抢先建立 transcript，历史快照被丢弃（2026-09-29，已修）

症状：打开一条有大量历史的会话后，页面最上面是刚收到的频道唤醒，上滑到顶也没有更早消息；JSONL 历史仍完整。这与 compaction 裁模型上下文**无关**。实证：会话 `01a0d12b` 当前分支有 346 条 message entry、零 compaction；截图顶端的 09:41:17 消息在 JSONL 第 367 行，前面有 36 条 user、126 条 assistant。正式版日志显示 09:41:17.305 channel-watch 投递唤醒，09:41:17.335 后端才报 session opened；trace 记录此后响应事件。

根因：`stores/sessions.ts` 的 `loadSessionBundleInner` 在历史 IPC 开始前以 `skipHistoryIfLive` 判断是否跳过，返回后又以 `liveNow` 判断是否丢弃历史。会话打开时频道扩展可能先唤醒 agent，事件桥建立了该 session 的 live transcript；于是历史即便读到了，也被 `if (history && !liveNow)` 丢弃。之后 live 事件只追加本次打开以来的新消息，结束时没有历史补拉；`switchSession` 只在 transcript **不存在**时懒加载，切回来也不会自愈。trace 不记录 `getSessionMessages` IPC，无法单独从 trace 断言哪一次守卫命中，但事件时序、截图起点与代码路径吻合。已知恢复手段：会话空闲后关闭并重新打开（或退出应用重进），让首次历史加载在无 live 竞态时完成；**不要删/改会话 JSONL**。

修复（分支 `fix/session-history-hydration-barrier`）：`channel-watch` 恢复订阅时不立即启 watcher/离线对账，而是异步等 renderer 首份完整历史回放的 `session:historyReady` ACK（不能在 SDK `session_start` 中 await ACK，会与 `openSession` 死锁）；等待中 cursor 不推进，15s 无 renderer 兜底放行、关闭作废；SDK `dispose()` 不发送 `session_shutdown`，backend 须显式停 watcher（只用 SDK 钩子会漏）。其他来源仍可能抢跑：renderer `stores/session-history.ts` 明确区分「有 live entry」与「历史已就绪」，agent_settled 后重新读最新分支（旧快照不可复用），openingEpoch 防止关闭重开被旧结果覆盖；切回待补会话也会重试。覆盖频道 ACK 前/后/关闭、live 抢跑/IPC 途中抢跑/关后同 ID 重开。频道订阅的后台会话并不依赖用户**正在查看**，只等初始化完成。

### UI 历史不能读取被压缩的模型上下文（2026-09-22）

症状：执行 compaction 后，当前界面的旧消息仍完整；过一段时间切走再回来，压缩前的大段内容却消失。目标会话文件有 1319 行、当前分支 1253 条 message entry，但两次压缩后 `AgentSession.messages` 只剩 251 条上下文消息；日志中的 GC close/open 正好对应“过段时间”这个触发点。

根因：实时 `compaction_end` 已刻意只追加分割线、不重置 UI，所以当下正常；但 GC 卸载再打开时，`getSessionMessages()` 错把 `AgentSession.messages` 当历史数据源。这个属性是**给模型下一轮请求使用的裁剪上下文**，不是完整会话历史。完整历史一直在 JSONL 会话树当前分支里，并未丢失。

对策：UI 回放统一读取 `sessionManager.getBranch()` 的全部 `message` entry，再转换并配对 entryId；模型调用仍使用 SDK 自己的 `session.messages`，两种语义不混用。文件只读透视也复用同一个 branch 转换函数。回归测试必须真实插入 compaction entry，并证明模型上下文缩短的同时 UI 历史仍包含压缩前消息。

### 渐变填充条：改 `width` 会把 `linear-gradient` 一起拉伸（2026-09-29）

症状：思考深度横条（模型弹层底部）要「左端蓝、右端紫」，按老写法 `width: 计算值` + `background: linear-gradient(...)`，拖动滑块时**同一条刻度下的颜色会变**——短填充把整条渐变压进一小段、长填充才铺开，看着像颜色自己在动。

原因：`linear-gradient` 按元素自身盒子铺，元素宽度变了渐变比例就跟着变。

做法：渐变层**铺满整条轨道**（`inset: 0`），用 `clip-path: inset(0 calc(100% - var(--fillw)) 0 0)` 裁出填充宽度（见 `styles/globals.css` 的 `.think-fill`）。适用于进度条 / 比例条 / 分段高亮。验证注意：`getBoundingClientRect()` 拿的是**未裁剪**的盒子（裁剪不影响布局），所以量宽度证明不了裁剪生效，得看截图或读 `clip-path` 计算值。

**2026-09-29 补（填充端要跟滑块圆对齐）**：思考条把「填充铺到滑块中心」当成终点，最低档就露馅——滑块中心在 13px（半个滑块）处，那 13px 填充的**圆角左帽**露出滑块圆外（滑块只盖 x∈[0,26] 的圆内区域），看着像滑块左半边有道渐变描边。三条路只有一条对：

1. 填充铺到**滑块中心**（`calc((100% - 26px) * pos + 13px)`）：方角边界恰好切在滑块圆最宽处、被盖住 ✅ ——但 **最低档（pos=0）必须特判成 0 宽**，否则就是上面那半截月牙；
2. 想靠「补一整个滑块宽（+26px）让右端与滑块同心」绕开特判 ❌：`border-radius` 打在**整条宽度**的元素上，`clip-path` 裁开后右端仍是**方角**，补多少就露多少方块到滑块右边（实测拍到了清晰的蓝色方块）；
3. 靠 `border-radius` 让右端成圆角 ❌：圆角帽会从滑块圆里拱出来（就是最低档那个月牙）。

判据：填充端是方角时，端点必须落在**滑块圆的最宽处**（= 滑块中心）；只要偏离，圆/方角都会露出滑块。

### headless 截图不绘制 `::-webkit-scrollbar`（2026-09-29）

症状：设计稿/验收截图里自定义滚动条（`.thin-scrollbar` 4px、全局 8px）完全不出现；量 `offsetWidth - clientWidth` 有的 0、有的正好 4px，容易误判「样式没生效」。

原因：macOS「滚动时才显示」策略下 Chromium 走 overlay 滚动条；`::-webkit-scrollbar` 的宽度只影响 `scrollbar-gutter: stable` 预留的宽度，thumb 本身不画（没滚动时也不显示）。Electron 真窗口里才是经典滚动条（用户截图里那根粗灰条就是）。

做法：截图核对滚动条时，要么在画板里手绘一根同规格的示意（`.local/design/ux/model-thinking-picker` 的画板 ⑤ 就这么干的），要么量 `offsetWidth - clientWidth`（`4px` = 生效）+ 真窗口肉眼确认。别据此判定样式坏了。

## 五、工程纪律

### renderer 单测跑在 node 环境：测不了 i18n 与返回 JSX 的模块函数（2026-09-20）

症状：给 `session-menu.test.ts` 加一条“draft 菜单只有一项”用例后，整个测试文件报 `TypeError: Cannot read properties of undefined (reading 'getItem')`（`i18n/index.ts` 的 `detectLanguage` 读 `localStorage`），改成不 import i18n 后变成 `React is not defined`（应用构建（ vite plugin-react）与 tsconfig 预期 **automatic** JSX runtime，所以源码里没有 `import React`；但 Vitest 这条路径把 `.tsx` 编成 `React.createElement` 的 **classic** 形式，于是调用 builder 时 `React` 不在作用域）。

原因：本仓 vitest 无 config（`electron.vite.config.ts` 不被 vitest 读取），环境是默认的 **node**：无 DOM/localStorage，且 esbuild 把 `.tsx` 编译成 `React.createElement`（classic）→ 一调就炸（上游：应用构建预期 automatic，两边 JSX runtime 不一致）。

对策（本期采用）：**把决策抽成不碰 JSX 的纯函数再测**（如 `sidebarMenuKind()`、`canOpenSessionMenu()`；当时举例的 `discardDraft()` 已随单例 draft 重构删除，见 2026-09-20 单例 draft 条目），JSX 菜单项本身交给 CDP 手测（真跑一遍比单测更接近用户行为）。若真需要渲染测试，得单独引入 jsdom + `esbuild: { jsx: "automatic" }`（新增 `packages/desktop/vitest.config.ts`），**别为一个 builder 就改全局测试环境**。

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

### 新会话页不变式：`activeSessionId === null` ⇒ 必有 draft，且 cwd 严格镜像 draft.cwd（2026-09-20，单例 draft 重构）

症状（本仓单例 draft 重构中连栽三轮 review，都是同一个根因的不同侧面）：

1. 新会话页（`activeSessionId === null`）却没有 draft —— 此时模型/思考/权限 picker 会把选择写进「不存在的东西」，用户看到**点了没反应**（静默丢失）。
   触发路径：关掉最后一个真实会话、promotion 迟到且用户此刻正停在新会话页。
2. 有 draft 但 `store.cwd` 与 `draft.cwd` 分叉 —— 页面/左栏 `activeCwd` 按 A 项目展开，promotion 却按 B 项目建会话；`draft.cwd === null`（还没选项目）时更隐蔽：store.cwd 回退成了上个会话的项目。

原因：把「当前页面的配置真相」和「当前会话」当成两份独立状态维护。`cwd` 尤其容易分叉 —— 它是 store 的全局字段，同时又由 draft 承载。

对策（现已落地，改动 store 时守住）：

- **唯一来源**：新会话的 cwd/模型/思考/权限只存在 `newSessionDraft` 里；`store.cwd` 在新会话页**严格镜像 `draft.cwd`（含 null，不回退到别的会话）**。
- **不变式要主动维护**：store 初始化即建一份 draft；`closeSession` 关掉最后一个会话、promotion 消费掉 draft 后若用户仍在新会话页，都必须**立刻补种**一份。
- **写 `cwd` 的所有路径都得盘一遍**：本仓共 6 处（init / switchSession / openFromHistory / promotion 成功与迟到 / activateNewSessionDraft / setDraftCwd），当时只有 `closeSession` 漏了。
- 单测里直接把这三者（`activeSessionId` / `draft.cwd` / `store.cwd`）**一起断言**，别只断言其中一个。

### contextBridge 暴露的 API 在页面里只读：CDP 验收脚本注不进 IPC 失败（2026-09-20）

症状：想在 CDP 验收里 `window.pi.createSession = ...` 注入失败/数调用次数 —— 赋值**静默无效**（`window.pi.createSession === orig` 仍成立），也 `Object.defineProperty` 不了（`{ writable: false, configurable: false }`）。同理 `getPi()` 所在的 ESM 模块命名空间也改不动。

对策：

- **失败路径**改用「受控失败路径」：例如把新会话 draft 的 `cwd` 置成 null（= 用户还没选项目）走 `createSession()` 的 null 返回分支，或直接在单测里 mock。**别指望在页面里拦 IPC**。
- **成功路径的 IPC 计数**：数主进程日志（本仓 backend 每次建会话会打 `session created`，脚本按行数取差），或用应用的 store 状态断言（页面内 `await import("/src/stores/*.ts")` 拿到的就是应用在用的同一份实例）。
- 需要「点真实子代理卡」这类依赖模型行为的场景，优先找**历史回放**入口：历史里已有子代理运行的父会话，打开它 → transcript 重放出卡片 → 点它，同样落到只读检视页，且完全确定性（子会话文件在 `<agentDir>/sessions-subagents/`，后端按路径判定 `readOnly`）。现场真跑一次 subagent 依赖凭证可用，dev 里常 401 拿不到可点卡片。

### 绝不打印/提交 API key

`models.json` 用环境变量引用（`$AI_OPS_API_KEY`），key 由用户自持。

### 已开源：github.com/Jaxton07/percho

git remote 走 SSH（本机直连 github.com:443 不通）。`main` 有分支保护（PR + CI `check` 必过 + squash merge），Release 由 tag 触发（`.github/workflows/release.yml`）。

## 六、Electron 主进程 · 窗口

### 持久化窗口 bounds 必须用 `getNormalBounds()`（2026-10-07，layout-freedom P1-B）

`getBounds()` 在窗口**最大化/全屏**时返回的是**最大化后的尺寸**（实测：普通态 940×660 → 最大化后 `getBounds()` 1512×859、`getNormalBounds()` 仍是 940×660）。把它写进 ui-state 后，下次启动会按「1512×859 + 原 x/y」构造窗口 —— 用户看到的是一个超出屏幕的普通窗口，看着像「窗口尺寸记忆坏了」。

配套两条同样重要：

- **退出兜底要同步写**：防抖窗口（400ms）内点 ✕ 直接 `app.quit()`，异步写盘队列可能来不及。用 `JsonStore.updateSync`（`saveUiStateSync`）在 `close` 回调里同步补一次，并且 **try/catch 只记日志**（写偏好失败绝不能阻塞退出）。
- **`updateSync` 不参与 async per-path 串行队列**（队列是模块级 Map）：所以它只用于退出兜底，别当常规写入路径（与队列里的写在 read-modify-write 上有交错可能，概率低、后果轻：丢一侧字段一次，下次写自愈）。

### macOS 首次 `show()` 会把窗口 x 抬到 ≥221 DIP（2026-10-07，layout-freedom，X1）

症状：把窗口拖到屏幕最左（x < 221）→ 退出 → 重启，窗口跑到 **x=221**，看着像「位置记忆失效」。实测（主进程探针 + 2ms 采样）：

- 构造函数传的 x 是**被接受的**（`show()` 之前 `getBounds().x === 180`），但 `show()` 一执行就被抬到 221；
- 同样输入下把宽度给到 1300 也只得到 1291（= 1512-221），说明是系统的「窗口必须留在屏上」约束，不是我们传参错了；
- 对照组（关掉校准）从 `show()` 后的第一个采样就是 221（到 500ms 都没变）；开校准后**第一个采样（16ms）已经是 180** —— `show()` 与 `setBounds()` 在同一 tick 内完成，中间没有渲染机会。

修法（`window.ts` 的 `ready-to-show`）：显示后比对 x/y，不一致就 `setBounds(记录的 bounds)`（**已显示**的窗口不受该约束）。注意这是 macOS 行为，其它平台 diff 为 0 时是 no-op。

### macOS 窗口只有 `resize` / `move`：`resized` / `moved` 一次都不来（2026-10-07，layout-freedom）

`window.resizeTo(w, h)` 期间在主进程挂 `resized` / `moved` 探针，实测 **0 次触发**（spec 里一度写着 macOS 上 `moved` 是 `move` 的别名，实际连别名都不触发）；同时单次 `resizeTo` 会来 **1~3 次** `resize`。结论：**只监听 `resize` + `move`，并且必须防抖**（否则拖窗口一路写盘）。
