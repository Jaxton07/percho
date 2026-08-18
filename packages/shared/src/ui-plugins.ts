/**
 * UI 插件系统跨进程类型（manifest / 插件信息 / 配置 / 事件载荷）。
 * 设计规范见 .local/docs/design/spec/ui-plugin-system.md §5/§8/§9。
 */

/**
 * 已知槽位名（main 进程校验 manifest.slots 用）。
 * 与 renderer 的 plugins/slots.ts 对齐（registry.test.ts 有断言），两处不可漂移。
 */
export const KNOWN_UI_SLOTS: string[] = ["chat.tool-call-card", "chat.subagent-card", "chat.todo-panel"];

/**
 * 已知区域名（main 进程校验 manifest.contributions 用；spec §15）。
 * 与 renderer 的 plugins/slots.ts 对齐（registry.test.ts 有断言），两处不可漂移。
 */
export const KNOWN_UI_REGIONS: string[] = [
	"app.background",
	"app.overlay",
	"chat.corner.top-left",
	"chat.corner.top-right",
	"chat.corner.bottom-left",
	"chat.corner.bottom-right",
	"settings.panel",
];

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
		}
	>;
	/** 槽位 → 指派的插件名（多插件争同一槽位时用户在设置面板选；单插件覆盖时自动指派） */
	assignments: Record<string, string>;
}

/** main → renderer 事件载荷 */
export type UiPluginsEventPayload = { kind: "changed"; name: string } | { kind: "config" };
