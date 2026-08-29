# Percho UI 插件开发规范（SPEC）

> 本文件随 Percho 分发（`userData/ui-plugins/SPEC.md`），是 agent 编写 UI 插件的唯一权威依据。
> 配套类型声明：同目录 `percho-ui.d.ts`（与宿主 `window.PerchoUI` 暴露清单**逐名一致**）。
> 完整示例：`examples/terminal-tool-card/`。槽位契约设计见宿主仓库 `.local/docs/design/spec/ui-plugin-system.md`。

## 1. 什么是 UI 插件

Percho 的某些前端组件是**可替换的命名槽位（Slot）**。插件 = `userData/ui-plugins/<name>/` 目录下的一个 TSX 包，构建在宿主 main 进程完成，产物在应用内运行，替换默认组件渲染。插件与宿主**共享同一个 React 实例**。

```
my-plugin/
├── plugin.json        # 清单（必需）
├── src/index.tsx      # 入口源码（agent 写的就是这个）
└── dist/index.js      # 构建产物（宿主生成，不要手改）
```

## 2. 槽位目录 v1 与 props 契约

| 槽位名 | props | 默认组件 |
|---|---|---|
| `chat.tool-call-card` | `{ tool: UIToolCall }` | 工具调用卡（折叠行：工具名 + 参数摘要 + 输出） |
| `chat.subagent-card` | `{ runs: SubagentRunUi[] }` | 子代理独立行（状态点 + 名称 + 点击打开子会话） |
| `chat.todo-panel` | `{}` | 任务列表面板（右上角胶囊，内部自行取数） |

```ts
interface UIToolCall {
	key: string;      // 本地稳定 id（React key 用）
	id: string;       // 真实 toolCall id
	name: string;     // 工具名，如 "bash"
	args: string;     // 参数摘要（JSON 或纯文本）
	output: string;   // 执行输出累积
	state: "running" | "done" | "error";
	blockIndex?: number;
}

interface SubagentRunUi {
	key: string;
	agent: string;
	task?: string;
	status: "running" | "done" | "error";
	model?: string;
	tokens?: number;
	exitCode?: number;
	artifactsDir?: string;
	sessionFile?: string;
}
```

`manifest.slots` 的 value 是入口 bundle 的**具名导出名**（一个插件可覆盖多个槽位）：

```json
{
	"name": "my-terminal-card",
	"version": "0.1.0",
	"displayName": "终端风工具卡",
	"description": "把工具调用卡改成终端样式",
	"perchoUi": 1,
	"main": "src/index.tsx",
	"slots": { "chat.tool-call-card": "ToolCallCard" }
}
```

字段规则（任一不满足 → 插件标记「清单无效」，不加载）：
- `name`：必填，`/^[a-z0-9][a-z0-9-]*$/`，**必须与目录名一致**；
- `perchoUi`：必填，宿主契约版本，当前只接受 `1`；
- `main`：必填，插件目录内相对路径，**禁止 `..` 穿越**；后缀 `.ts/.tsx/.js/.jsx`；
- `slots`：必填非空对象，key 必须是上表槽位名，value 是具名导出名；
- `version` / `displayName` / `description`：可选展示字段。

## 3. 可用导入（两个虚拟模块 + 静态图片资产）

插件里**只允许**两类导入：

```ts
import { useState, memo } from "react";                 // react（含 react/jsx-runtime，JSX 自动使用）
import { Button, useT } from "@percho/plugin-api";      // 宿主 API（见 §4）
import idleUrl from "./assets/idle.png";                // 插件目录内图片资产（见下）
```

**图片与音频资产**：相对路径导入图片（`.png` / `.webp` / `.gif` / `.jpg` / `.jpeg`）与音频（`.mp3` / `.m4a` / `.aac` / `.ogg` / `.wav`），构建器（esbuild dataurl loader）
把文件打成 `data:` URL 字符串内联进产物（默认导出 = URL），CSP `img-src` 与 `media-src` 均放行 `data:`（音频用 `new Audio(url)` 播放）。
适合桌宠立绘、雪碧图、语音提醒/音效等场景。纪律：
- 只接受插件目录内的**相对路径**（`./` 或 `../` 开头但不得穿出插件目录）；裸导入图片/音频包名仍失败；
- 体积即产物体积（base64 再 +33%）：图片先缩到实际显示尺寸的 2x（Retina）再导入，5 张 760px PNG ≈ 2MB 产物是可接受上限量级；音频建议有损格式（几秒语音的 mp3/m4a 约几十 KB，wav 动辄几 MB）；
- 资产改动同样触发热重载（watch 覆盖整个插件目录，除 dist/）。

**硬约束**：

- ❌ 禁止 import 任何其他 npm 包（构建器只重写上述四个 specifier，其余裸导入构建直接失败）；
- ❌ 禁止 Node API（`process`/`fs`/`path`/`require` 等都不存在——代码跑在浏览器沙箱渲染进程）；
- ❌ 禁止 `fetch`/网络请求、`localStorage`（宿主未授权，且 CSP 会拦）；
- ❌ 禁止直接访问 `window.pi` 做任何 IPC 调用（信任模型边界，插件只准用 `window.PerchoUI` 暴露的能力）；
- ✅ 允许 `window.PerchoUI` 的 hooks 取宿主 store 数据（如 todo 面板替换）。

## 4. `@percho/plugin-api` 导出清单

```ts
export const version;                       // 宿主 API 版本（1）
export const components: {                  // 宿主精选组件（复用，不重造轮子）
	Button; Dropdown; Tooltip; Markdown; ImagePreview;
};
export const helpers: {
	summarizeArgs(args: string): string;    // 参数摘要（取 command/path/url，流式容错）
	displayToolName(name: string): string;  // 工具名首字母大写
};
export const hooks: {
	useT(): (key: string, params?) => string; // i18n（key 用宿主既有字典，如 "message.working"）
};
export const stores: {                      // 宿主 zustand store（与宿主同一实例）
	useTranscriptStore; useSessionsStore; useUiStore; useProjectsStore; useSettingsStore;
	useUiPreferencesStore;                   // 应用级 UI 偏好（ui-state.json 持久化：轨道/中央动画等开关）
};
```

`react` 的完整导出（`Children`/`Component`/`memo`/`useEffect` 等全部 hooks）也可用，见 `percho-ui.d.ts`。

## 5. 样式纪律（强制）

- **一律语义 token**：`bg-canvas` / `bg-surface` / `bg-hover` / `text-ink` / `text-ink-2` / `text-ink-dim` / `text-ink-faint` / `border-border` / `shadow-soft` / `shadow-pop` / `text-accent` 等（宿主 Tailwind 已全局注册）。**禁写死 zinc/white/black 等裸色值**——深浅主题都要检查一遍，插件必须两态可读；
- 动画：加 `motion-reduce:` 退化（如 `motion-reduce:transition-none`），尊重系统减少动态；
- 圆角/字号跟随宿主既有组件习惯（`rounded-lg`、`text-[13px]` 等），不要引入突兀的大块面；
- 状态色（成功/失败/进行中）用宿主既有语义（`text-green-500` / `text-red-500` / `text-accent`）。

## 6. 性能

- 导出的组件**必须 `React.memo` 包裹**（槽位在每条消息的热路径上渲染，memo 可跳过无关注入重渲）；
- 不要在渲染里做重计算（`useMemo` 缓存派生值）；流式输出更新频繁，保持组件轻量。

## 7. 热重载流程

宿主对 `userData/ui-plugins/` 开 fs.watch：`src/` 或 `plugin.json` 保存后 **300ms 防抖自动重建**并热替换（无需重启应用）。构建失败 → 旧版继续生效，设置面板显示错误。**保存即见效**是设计目标，改完直接看界面。

## 8. 完整示例

`_examples/terminal-tool-card/`（随包分发，seedDocs 拷进插件根目录时改名为 `_examples`——下划线开头不被当插件扫描），要点齐全：memo 包裹、语义 token、useT、折叠 details 结构。照抄改即可。

## 9. 交付闭环（agent 标准流程）

1. 读本 SPEC + `percho-ui.d.ts`；
2. 在 `~/.percho/ui-plugins/<name>/`（=`userData/ui-plugins/<name>/`，宿主已建 symlink）scaffold：`plugin.json` + `src/index.tsx`；
3. 保存 → 宿主自动构建（面板若显示「构建失败」则修语法/导入问题）；
4. **引导用户去 设置 → UI 插件 面板启用**（总开关 + 插件启用带二次确认，agent 无权代劳——这是信任门）；
5. 用户确认替换生效后，迭代样式时直接改 `src/index.tsx` 保存即可热替换。

## 10. Region/Contribution：往页面加挂新组件（Phase 3）

Slot 是「替换」，Region/Contribution 是「新增」：插件可以在宿主界面的固定「区域」加挂组件（桌宠 / token 仪表盘 / 氛围光效 / 插件自带设置页）。一个区域可挂 N 个贡献（堆叠），同一插件可同时声明 `slots` 与 `contributions`。贡献**无 props**，数据一律从 `window.PerchoUI.stores` / `hooks` 自取（store 连接型）。

### 10.1 区域目录 v1 与 manifest

| 区域 | 挂载点 | 定位语义 | 典型用途 |
|---|---|---|---|
| `app.background` | App 根、内容列之前 | 绝对填充 z-0 | 动态背景 |
| `app.overlay` | App 根、内容列之后、弹窗之前 | 每贡献一个 `fixed inset-0 z-20` 容器 + anchor 九宫格对齐 | 桌宠、悬浮物 |
| `chat.corner.top-left` / `top-right` / `bottom-left` / `bottom-right` | 聊天区 main 内 | `absolute z-20` 同角纵向堆叠（顺序=启用先后） | 小部件 |
| `settings.panel` | 设置弹窗 | 独立分类页（分类标题 = `title`） | 插件配置页 |

z 序：背景 0 < 内容 10 < overlay 20 < 设置弹窗 40 < 信任弹窗/全屏预览 50。**插件层永在弹窗之下**。

```json
{
	"name": "my-pet",
	"perchoUi": 1,
	"main": "src/index.tsx",
	"contributions": [
		{ "id": "pet", "region": "app.overlay", "anchor": "bottom-right", "export": "Pet", "title": "桌宠" }
	]
}
```

字段规则（`slots` 与 `contributions` **至少其一非空**）：
- `id`：必填 slug（`/^[a-z0-9][a-z0-9-]*$/`），插件内唯一；
- `region`：必填，∈ 上表区域；未知区域由宿主告警并忽略该条（不判无效）；
- `export`：必填，入口 bundle 的具名导出名；
- `anchor`：仅 `app.overlay` 有意义，九宫格枚举 `top-left/top-center/top-right/center-left/center/center-right/bottom-left/bottom-center/bottom-right`，缺省 `bottom-right`；其他区域忽略该字段；
- `title`：可选展示名（`settings.panel` 用作设置分类标题）。

### 10.2 三条硬纪律

1. **pointer-events**：overlay / background / corner 容器一律 `pointer-events-none`（不挡宿主交互）；插件需要交互的子树自己开 `pointer-events-auto`（如宠物本体）；
2. **性能**：常驻动画只走 CSS transform/opacity（合成器线程）；`prefers-reduced-motion` 必须退化（如 `@media (prefers-reduced-motion: reduce) { … animation: none }`）；禁主线程重计算；
3. **可见性**：`app.background` 在默认不透明界面下**不可见**（与自定义背景图同规则）——氛围光效请走 `app.overlay` + 半透明渐变 / `mix-blend-mode`，不要写看不见的插件。

### 10.3 其他约定

- `chat.corner.top-right` 与任务列表面板（TodoPanel）同角：宿主容器已预留 `pt-12` 偏移，贡献堆在面板下方；面板展开（完整列表）时可能遮挡贡献，属预期；
- 同角多贡献纵向堆叠，顺序 = 启用先后（先启用的在上）；
- `settings.panel` 贡献渲染为设置弹窗的独立分类（分类 id `plugin:<name>:<cid>`，标题 = `title`），随插件启停自动增删；
- 排查：贡献根元素外层的宿主容器挂 `data-plugin="<name>"` 属性（插件无需自己做）；
- **内置插件**：`resources/ui-plugins/builtin/` 随包分发，应用首次启动/升级时导出到用户插件目录（与用户插件同一条扫描/构建/热重载路径，面板带「内置」badge、启用免二次确认）。**直接改内置副本会在下次升级被覆盖——魔改请把目录改名另存**（`plugin.json` 的 `name` 同步改）；手动删除的目录本版本内不会回来，下次升级重新导出；
- 新 hooks（`percho-ui.d.ts` 已声明）：`useContextUsage(sessionId)` 返回 `{ tokens, contextWindow, percent }`（事件驱动刷新，token 仪表盘用）；`useLanguage()` 返回 `"zh" | "en"`（插件自有文案跟随中英）。

### 10.4 示例

`_examples/overlay-pet/`（桌宠：跟 `useTranscriptStore` 的 agentActive 呼吸，CSS transform 动画 + reduced-motion 退化）与 `_examples/token-meter/`（迷你仪表盘：`useContextUsage` + `chat.corner.top-right`）——照抄改即可。

## 11. 无头插件（Phase 4）：不渲染任何组件的常驻副作用

Slot 是「替换组件」，Contribution 是「加挂组件」，Headless 是「零组件」：插件只提供一段常驻逻辑（订阅宿主 store、定时器、播放音频……），适合语音提醒、状态监控、通知桥接类功能。manifest 声明 `"headless": true`（与 slots/contributions 至少其一，可并存——同一插件既替换组件又跑副作用）：

```json
{
	"name": "voice-alerts",
	"perchoUi": 1,
	"main": "src/index.ts",
	"headless": true
}
```

入口导出 `activate(): (() => void) | void`：插件加载（含热重载重载）时调用；返回的清理函数在**禁用/卸载/热重载替换**时调用（无返回值则无清理）：

```ts
import { stores } from "@percho/plugin-api";

export function activate() {
	// 命令式访问宿主 store（无头插件没有组件，不用 hook）
	const unsub = stores.useTranscriptStore.subscribe(() => { /* ... getState() 取最新 ... */ });
	return () => unsub(); // 清理：解订阅/关定时器，别留泄漏
}
```

纪律：
- `activate` 抛错或缺导出 → 该插件记为加载失败（等同槽位导出缺失），不炸宿主；清理函数抛错只告警；
- 与组件插件同一条启用/信任/热重载路径，面板中「无槽位/无贡献」即无头插件；
- 参考实现：随包内置插件 `builtin/voice-alerts/`（语音提醒）：全局安静检测 + `new Audio(dataUrl)` 播放，开关即插件启用开关（禁用 = 卸载副作用）。
