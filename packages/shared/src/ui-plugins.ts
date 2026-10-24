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
	/**
	 * 版式（仅 settings.panel 有意义，需 perchoUi ≥ 2）：
	 * - form（缺省）：内容区已带 padding 与滚动，插件只排内容；
	 * - full：不套 padding、不假设单一滚动容器，插件自管滚动/粘性条/分栏。
	 */
	layout?: "form" | "full";
	/**
	 * 隔离方式（需 perchoUi ≥ 2）：
	 * - light（缺省）：与宿主同一 DOM，可用宿主 Tailwind 工具类，样式双向可见（v1 行为）；
	 * - shadow：挂到 shadow root，注入宿主插件主题表（令牌 + 语义类），插件自带样式不外泄，
	 *   宿主 CSS 也改不动插件页；拿不到宿主 Tailwind 工具类。
	 */
	isolation?: "light" | "shadow";
}

/** 插件配置值：JSON 标量（宿主拒绝对象/数组，防深层结构与原型污染） */
export type UiPluginSettingValue = string | number | boolean | null;

/** 插件文案：单字符串或双语对象（双语对象跟随宿主语言切换） */
export type UiPluginText = string | { zh: string; en: string };

/** 声明式设置项：宿主按这张表自动渲染标准设置页，插件零样式代码 */
export interface UiPluginSettingField {
	type: "boolean" | "string" | "number" | "select";
	label: UiPluginText;
	hint?: UiPluginText;
	/** 未设置时的初始值（同时决定字段类型语义） */
	default?: UiPluginSettingValue;
	placeholder?: string;
	/** select 选项（value 即落盘值） */
	options?: { value: string; label: UiPluginText }[];
	/** 多行文本（type=string） */
	multiline?: boolean;
	/** 数值范围/步进（type=number） */
	min?: number;
	max?: number;
	step?: number;
}

/** 一次版本升级的迁移步骤：只做改名/删键/补默认值，不执行插件代码 */
export interface UiPluginSettingsMigration {
	/** 旧键 → 新键（新键已存在时保留新键，不覆盖用户已设置的值） */
	rename?: Record<string, string>;
	/** 丢弃的旧键 */
	drop?: string[];
	/** 补写的新键（仅在缺键时写入） */
	set?: Record<string, UiPluginSettingValue>;
}

/** 插件的声明式设置表（manifest.settingsSchema） */
export interface UiPluginSettingsSchema {
	/**
	 * 配置版本：改动 fields 时递增。宿主按 migrations 把旧配置逐级升到当前版本，
	 * 插件不写迁移代码（缺步骤 = 停在那一级，不会误标成"已迁移"）。
	 */
	version?: number;
	/** 迁移脚本：key = 目标版本号（"2" 表示把 v1 升到 v2），宿主从存储的版本逐级跑到 version */
	migrations?: Record<string, UiPluginSettingsMigration>;
	fields: Record<string, UiPluginSettingField>;
}

/** 插件清单（userData/ui-plugins/<name>/plugin.json） */
export interface UiPluginManifest {
	/** 必填：/^[a-z0-9][a-z0-9-]*$/ 且必须与目录名一致 */
	name: string;
	/** 必填：宿主契约版本，接受 1（v1 行为）与 2（styles / settingsSchema / layout / isolation） */
	perchoUi: number;
	/** 必填：插件目录内相对路径，禁止 .. 穿越；后缀 .ts/.tsx/.js/.jsx */
	main: string;
	/** 槽位 → 入口 bundle 的具名导出名（key 必须是已知槽位名）；slots 与 contributions 至少其一非空 */
	slots?: Record<string, string>;
	/** 区域贡献（往页面加挂组件，一区域可多个堆叠）；slots 与 contributions 至少其一非空 */
	contributions?: UiPluginContribution[];
	/** 无头插件（spec §11）：不提供任何组件，加载时调用入口导出 `activate()`（可返回清理函数，禁用/热重载时调用）。slots / contributions / headless 至少其一 */
	headless?: boolean;
	/**
	 * 插件样式（需 perchoUi ≥ 2）：目录内相对路径数组（禁 .. 穿越），esbuild 打成一个 css，
	 * 仅 isolation=shadow 的贡献会注入其 shadow root（light 隔离下宿主不注入，避免污染全局）。
	 */
	styles?: string[];
	/** 声明式设置表：宿主自动生成设置页（与 settings.panel 贡献并存时以贡献为准） */
	settingsSchema?: UiPluginSettingsSchema;
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
	/** 声明式设置表（设置面板据此为插件生成「设置」分类，无需 settings.panel 贡献） */
	settingsSchema?: UiPluginSettingsSchema;
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
			/** 已信任（启用即置 true：启用动作 = 信任动作） */
			trusted: boolean;
			/** 插件自有配置（声明式设置页与 usePluginSettings 写的就是这里） */
			settings?: Record<string, UiPluginSettingValue>;
			/** 已迁移到的 settingsSchema.version（缺省 0 = 从未迁移；只由宿主维护） */
			settingsVersion?: number;
		}
	>;
	/** 槽位 → 指派的插件名（多插件争同一槽位时用户在设置面板选；单插件覆盖时自动指派） */
	assignments: Record<string, string>;
}

/** main → renderer 事件载荷 */
export type UiPluginsEventPayload =
	| { kind: "changed"; name: string }
	| { kind: "config" }
	/** 只动了某个插件的自有配置：renderer 只需重读它的配置，不必重载插件代码 */
	| { kind: "settings"; name: string };
