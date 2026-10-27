/**
 * UI 插件系统跨进程类型（manifest / 插件信息 / 配置 / 事件载荷）。
 * 设计规范见 .local/docs/design/spec/ui-plugin-system.md §5/§8/§9。
 */

/** 槽位/区域标识的唯一来源；renderer重导出，main manifest校验从值派生。 */
export const UI_SLOTS = {
	ToolCallCard: "chat.tool-call-card",
	SubagentCard: "chat.subagent-card",
	TodoPanel: "chat.todo-panel",
} as const;
export type SlotName = (typeof UI_SLOTS)[keyof typeof UI_SLOTS];
export const KNOWN_UI_SLOTS: string[] = Object.values(UI_SLOTS);

export const UI_REGIONS = {
	AppBackground: "app.background",
	AppOverlay: "app.overlay",
	CornerTopLeft: "chat.corner.top-left",
	CornerTopRight: "chat.corner.top-right",
	CornerBottomLeft: "chat.corner.bottom-left",
	CornerBottomRight: "chat.corner.bottom-right",
	/** 输入框底部工具行（ContextRing旁） */
	ComposerFooter: "composer.footer",
	/** 输入框正上方（整列顶部，错误条之上）：发送前的摘要类信息 */
	ComposerTop: "composer.top",
	SettingsPanel: "settings.panel",
} as const;
export type RegionName = (typeof UI_REGIONS)[keyof typeof UI_REGIONS];
export const KNOWN_UI_REGIONS: string[] = Object.values(UI_REGIONS);

/** app.overlay 的九宫格锚点枚举（spec §16） */
export const UI_PLUGIN_ANCHORS = [
	"top-left",
	"top-center",
	"top-right",
	"center-left",
	"center",
	"center-right",
	"bottom-left",
	"bottom-center",
	"bottom-right",
] as const;
export type UiPluginAnchor = (typeof UI_PLUGIN_ANCHORS)[number];

/** 一条区域贡献声明（spec §16）：id 必填 slug（插件内唯一）；region 必须是已知区域 */
export interface UiPluginContribution {
	/** 必填：/^[a-z0-9][a-z0-9-]*$/，插件内唯一 */
	id: string;
	/** 必填：∈ KNOWN_UI_REGIONS（未知 region 校验报警告并忽略该条，不判 invalid） */
	region: string;
	/** 必填：入口 bundle 的具名导出名 */
	export: string;
	/** 仅 app.overlay 有意义：九宫格锚点，缺省 bottom-right；其他区域忽略 */
	anchor?: UiPluginAnchor;
	/** 可选展示名（settings.panel 用作分类标题） */
	title?: string;
}

/** 插件清单（userData/ui-plugins/<name>/plugin.json） */
export interface UiPluginManifest {
	/** 必填：/^[a-z0-9][a-z0-9-]*$/ 且必须与目录名一致 */
	name: string;
	/** 必填：宿主契约版本，当前只接受 1 */
	perchoUi: number;
	/** 必填：插件目录内相对路径，禁止 .. 穿越；后缀 .ts/.tsx/.js/.jsx */
	main: string;
	/** 槽位 → 入口 bundle 的具名导出名（key 必须是已知槽位名）；slots 与 contributions 至少其一非空 */
	slots?: Record<string, string>;
	/** 区域贡献（往页面加挂组件，一区域可多个堆叠）；slots 与 contributions 至少其一非空 */
	contributions?: UiPluginContribution[];
	/** 无头插件（spec §11）：不提供任何组件，加载时调用入口导出 `activate()`（可返回清理函数，禁用/热重载时调用）。slots / contributions / headless 至少其一 */
	headless?: boolean;
	/** 可选展示字段 */
	version?: string;
	displayName?: string;
	description?: string;
}

/** 扫描合成的插件运行时信息（设置面板展示 + 加载筛选） */
export interface UiPluginInfo {
	name: string;
	displayName?: string;
	description?: string;
	version?: string;
	perchoUi?: number;
	/** manifest 声明的槽位 → 导出名 */
	slots: Record<string, string>;
	/** manifest 声明的区域贡献（未知 region 条目已过滤） */
	contributions: UiPluginContribution[];
	/** 无头插件（声明 headless，无槽位/贡献，仅 activate 副作用） */
	headless?: boolean;
	enabled: boolean;
	trusted: boolean;
	/** manifest 校验失败原因（invalid 时不参与加载） */
	invalidReason?: string;
	/** 最近一次构建错误（有旧产物时旧版仍生效） */
	buildError?: string;
	/** dist 产物是否存在 */
	built: boolean;
	/** 内置插件（随包分发于 resources/ui-plugins/builtin/，源码只读，产物构建到 userData 版本化缓存）；userData 同名插件会遮蔽它 */
	builtin?: boolean;
}

/** 持久化配置（userData/ui-plugins.json） */
export interface UiPluginsConfig {
	/** 全局总开关（默认 false！首次发布保守默认） */
	enabled: boolean;
	plugins: Record<
		string,
		{
			/** 单个插件启用（默认 false） */
			enabled: boolean;
			/** Explicit workbench-wide trust, including local and remote content. Legacy trust does not imply this. */
			workbenchTrusted?: boolean;
			/** 已信任（启用即置 true：启用动作 = 信任动作） */
			trusted: boolean;
		}
	>;
	/** 槽位 → 指派的插件名（多插件争同一槽位时用户在设置面板选；单插件覆盖时自动指派） */
	assignments: Record<string, string>;
}

/** main → renderer 事件载荷 */
export type UiPluginsEventPayload = { kind: "changed"; name: string } | { kind: "config" };

export const UI_WORKBENCH_TRUST_COPY: Record<
	"zh" | "en",
	{ title: string; detail: string; allow: string; cancel: string }
> = {
	zh: {
		title: "允许 UI 插件访问整个工作台？",
		detail:
			"以下本机 UI 插件可访问本机与远端的项目、会话和配置，并调用宿主 API。关闭插件不能撤销已执行代码。只对信任的代码继续；拒绝后本机继续可用，远端内容暂不接入。",
		allow: "信任整个工作台",
		cancel: "暂不允许",
	},
	en: {
		title: "Trust UI plugins across the workbench?",
		detail:
			"These locally installed UI plugins can access local and remote projects, sessions and settings, and call host APIs. Disabling a plugin cannot revoke code already executed. Continue only for trusted code. Declining keeps local work available and pauses remote content access.",
		allow: "Trust across workbench",
		cancel: "Not now",
	},
};
