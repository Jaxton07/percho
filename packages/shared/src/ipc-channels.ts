import type { ChannelSubscriptionsSnapshot } from "./channel-subscriptions";
import type { ComposerDocument } from "./composer-document";
import type { EnvironmentRef } from "./environment";
import type { EnvironmentUiState } from "./environment-ui-state";
import type {
	ExtensionDialogRequest,
	ExtensionDialogResolved,
	ExtensionDialogRespond,
	ExtensionEditorTextEvent,
	ExtensionNotifyEvent,
} from "./extension-dialog";
import type { LanStatus } from "./lan";
import type { McpConfigListResult, McpMutationResult, McpServersChangedPayload, McpUpsertInput } from "./mcp";
import type { CatalogPackageType, CatalogSearchResult, ConfiguredPackageInfo } from "./packages";
import type {
	MutationReceipt,
	RemoteAuthGuide,
	RemoteConnectionStatus,
	SshAliasDiscovery,
	SshPreflight,
} from "./remote-runtime";
import { type ArgumentRules, input, validateArguments } from "./request-validation";
import type {
	AppInfo,
	AvailableModel,
	ChannelWatchConfigInfo,
	ContextUsageInfo,
	CreateSessionOptions,
	GitBranches,
	ImageInput,
	LoadedResources,
	LoadedSessionSummary,
	PendingInteractions,
	PermissionAnswer,
	PermissionConfigInfo,
	PermissionMode,
	PermissionRequest,
	PermissionResolved,
	QueuedMessages,
	QuotaInfo,
	SessionBaseline,
	SessionCloseIntent,
	SessionEventEnvelope,
	SessionMessage,
	SessionMeta,
	SessionStats,
	SlashCommandInfo,
	TrustAnswer,
	TrustRequest,
	TrustResolved,
	UiState,
} from "./session";
import type {
	CustomProviderInput,
	CustomProviderUpdateInput,
	ListProvidersOptions,
	LoginEventPayload,
	LoginResult,
	ModelPrefs,
	ProviderInfo,
	ProviderTestResult,
	SubagentInfo,
	UpstreamModelsInput,
	UpstreamModelsResult,
} from "./settings";
import type { StorageStartupAction, StorageStartupState } from "./storage-startup";
import type { TodoItem } from "./todo";
import type { UiPluginInfo, UiPluginManifest, UiPluginsConfig, UiPluginsEventPayload } from "./ui-plugins";
import type { UpdateState } from "./update";
import type { UpdateDiagnosticsInfo } from "./update-diagnostics";

/**
 * IPC invoke 通道单一事实源（D5）：key（= PiApi 方法名）→ 通道字符串 + 参数/返回类型。
 *
 * 约定：
 * - 参数统一「单对象」形态（无参通道 args = void）；main→renderer 单向事件通道不在此表
 *   （见下方 SUBSCRIPTION_TABLE，send-only 无 invoke 返回语义）
 * - ch("domain:action")<{...args}, Ret>()：通道字面量只写一次，运行时包含执行域、读/变更分类与参数校验
 * - main 侧经 registerInvokeHandlers(子表, handlers) 注册；preload 对 CHANNEL_TABLE 循环注册
 */

/** 通道定义：channel 字面量 + args/ret（args/ret 仅类型占位，运行时不存在） */
export type ChannelScope = "environment" | "desktop";

export interface ChannelDef<
	C extends string = string,
	A = void,
	R = unknown,
	S extends ChannelScope = ChannelScope,
> {
	channel: C;
	scope: S;
	operation: "read" | "mutation";
	validate: (value: unknown) => void;
	args: A;
	ret: R;
}

/** 已知 channel 字面量的 args/ret 构造器（第二段显式泛型） */
export type ChannelCtor<C extends string, S extends ChannelScope = "environment"> = <A, R>(
	...rules: S extends "desktop"
		? [fields?: ArgumentRules<A>]
		: A extends void
			? []
			: [fields: ArgumentRules<A>]
) => ChannelDef<C, A, R, S>;

export function ch<const C extends string, const S extends ChannelScope = "environment">(
	channel: C,
	scope: S = "environment" as S,
	operation: "read" | "mutation" = "mutation",
): ChannelCtor<C, S> {
	const ctor = (fields?: Record<string, import("./request-validation").InputRule<unknown>>) => ({
		channel,
		scope,
		operation,
		validate: (value: unknown) => validateArguments(fields, value),
	});
	return ctor as unknown as ChannelCtor<C, S>;
}

/** 泛型容器最小约束（args/ret 任意；channel 字面量保留） */
export type AnyChannelDef = ChannelDef<string, any, any>;

/** 会话域：生命周期/提示/导出/fork/撤回 + 模型列表 */
export const SESSION_CHANNELS = {
	/** 建会话（cwd 必选；模型/思考级别可选，缺省用全局默认） */
	createSession: ch(
		"session:create",
		"environment",
		"mutation",
	)<{ options: CreateSessionOptions }, SessionMeta>({
		options: input.object({
			cwd: input.id,
			provider: input.optional(input.id),
			modelId: input.optional(input.id),
			thinkingLevel: input.optional(input.text),
		}),
	}),
	/** 列当前目录历史会话（排除活跃） */
	listSessions: ch(
		"session:list",
		"environment",
		"read",
	)<{ cwd?: string }, SessionMeta[]>({ cwd: input.optional(input.id) }),
	/** opencode-go 套餐额度（全局；无 key/无订阅 null） */
	getQuota: ch("session:getQuota", "environment", "read")<void, QuotaInfo | null>(),
	/** 设置当前会话模型（同步 SDK；失败 renderer 回滚） */
	setModel: ch(
		"session:setModel",
		"environment",
		"mutation",
	)<{ sessionId: string; provider: string; modelId: string }, void>({
		sessionId: input.id,
		provider: input.id,
		modelId: input.id,
	}),
	/** 跨全部项目目录枚举历史会话（项目管理页用，含活跃） */
	listAllSessions: ch("session:listAll", "environment", "read")<void, SessionMeta[]>(),
	openSession: ch(
		"session:open",
		"environment",
		"mutation",
	)<{ filePath: string }, SessionMeta>({ filePath: input.id }),
	// closed=false = 后端拒绝（agent 正在跑/等审批，见 PiBackend.closeSession 的 isStreaming 守卫；
	// intent:"gc" 且有频道订阅时也拒绝，见 channel-watch retention）；
	// 没有该会话（已关/从未打开）也算 closed=true（幂等「它就是没在跑」）
	closeSession: ch(
		"session:close",
		"environment",
		"mutation",
	)<{ sessionId: string; intent?: SessionCloseIntent }, { closed: boolean }>({
		sessionId: input.id,
		intent: input.optional(input.oneOf("user", "gc")),
	}),
	/** 删除会话（含磁盘 jsonl 文件，不可恢复） */
	deleteSession: ch(
		"session:delete",
		"environment",
		"mutation",
	)<{ sessionId: string; sessionFile?: string }, void>({
		sessionId: input.id,
		sessionFile: input.optional(input.text),
	}),
	/** 发送消息；images 为随消息附带的图片（base64） */
	prompt: ch(
		"session:prompt",
		"environment",
		"mutation",
	)<{ sessionId: string; text: string; images?: ImageInput[]; document?: ComposerDocument }, void>({
		sessionId: input.id,
		text: input.text,
		images: input.optional(input.array(input.object({ data: input.text, mimeType: input.text }))),
		document: input.optional(input.jsonObject<ComposerDocument>()),
	}),
	/** 仅重试当前末端模型失败，不新增用户消息；受理即返回，执行结果走事件流。 */
	retryLastFailedTurn: ch(
		"session:retryLastFailedTurn",
		"environment",
		"mutation",
	)<{ sessionId: string; ref: { timestamp: number; entryId: string } }, void>({
		sessionId: input.id,
		ref: input.object({ timestamp: input.number, entryId: input.text }),
	}),
	abort: ch("session:abort", "environment", "mutation")<{ sessionId: string }, void>({ sessionId: input.id }),
	setThinkingLevel: ch(
		"session:setThinkingLevel",
		"environment",
		"mutation",
	)<{ sessionId: string; level: string }, void>({ sessionId: input.id, level: input.text }),
	/** 读取会话历史消息（打开历史会话时回放） */
	getPendingInteractions: ch("session:getPendingInteractions", "environment", "read")<
		void,
		PendingInteractions
	>(),
	getLoadedSessions: ch("session:getLoaded", "environment", "read")<void, LoadedSessionSummary[]>(),
	getSessionBaseline: ch(
		"session:getBaseline",
		"environment",
		"read",
	)<{ sessionId: string }, SessionBaseline>({ sessionId: input.id }),

	getSessionMessages: ch(
		"session:getMessages",
		"environment",
		"read",
	)<{ sessionId: string }, SessionMessage[]>({ sessionId: input.id }),
	/** 首份完整历史已落到 renderer；解除启动期频道唤醒屏障 */
	markSessionHistoryReady: ch(
		"session:historyReady",
		"environment",
		"mutation",
	)<{ sessionId: string }, void>({ sessionId: input.id }),
	/** 读取会话当前 todo 列表（无则空数组） */
	getTodos: ch(
		"session:getTodos",
		"environment",
		"read",
	)<{ sessionId: string }, TodoItem[]>({ sessionId: input.id }),
	compact: ch(
		"session:compact",
		"environment",
		"mutation",
	)<{ sessionId: string; customInstructions?: string }, void>({
		sessionId: input.id,
		customInstructions: input.optional(input.text),
	}),
	getStats: ch(
		"session:stats",
		"environment",
		"read",
	)<{ sessionId: string }, SessionStats>({ sessionId: input.id }),
	/** 当前模型上下文使用（无会话或未知时返回 null） */
	getContextUsage: ch(
		"session:getContextUsage",
		"environment",
		"read",
	)<{ sessionId: string }, ContextUsageInfo | null>({ sessionId: input.id }),
	/** 清空运行中排队的消息，返回被清内容（还原草稿用） */
	clearQueue: ch(
		"session:clearQueue",
		"environment",
		"mutation",
	)<{ sessionId: string }, QueuedMessages>({ sessionId: input.id }),
	getFollowUpMessages: ch(
		"session:getFollowUpMessages",
		"environment",
		"read",
	)<{ sessionId: string }, string[]>({ sessionId: input.id }),
	listSlashCommands: ch(
		"session:listSlashCommands",
		"environment",
		"read",
	)<{ sessionId: string }, SlashCommandInfo[]>({ sessionId: input.id }),
	/** 无会话斜杠命令列表（draft 新会话按 cwd 拉取；信任未决不弹窗，只含用户级资源） */
	listSlashCommandsForCwd: ch(
		"session:listSlashCommandsForCwd",
		"environment",
		"read",
	)<{ cwd?: string }, SlashCommandInfo[]>({ cwd: input.optional(input.id) }),
	/** 改会话名；历史会话走离线写会话文件，`cwd` 用于精确定位文件（见 PiBackend.setSessionName） */
	setSessionName: ch(
		"session:setName",
		"environment",
		"mutation",
	)<{ sessionId: string; name: string; cwd?: string }, void>({
		sessionId: input.id,
		name: input.text,
		cwd: input.optional(input.id),
	}),
	exportSession: ch(
		"session:export",
		"environment",
		"mutation",
	)<{ sessionId: string; format: "html" | "jsonl" }, string>({
		sessionId: input.id,
		format: input.oneOf("html", "jsonl"),
	}),
	/** fork：以 ref 定位分支点新建会话 */
	forkSession: ch(
		"session:fork",
		"environment",
		"mutation",
	)<{ sessionId: string; ref: { entryId?: string; text?: string } }, SessionMeta>({
		sessionId: input.id,
		ref: input.object({ entryId: input.optional(input.text), text: input.optional(input.text) }),
	}),
	/** 撤回用户消息（回退到该消息之前，内容放回输入框） */
	recallMessage: ch(
		"session:recall",
		"environment",
		"mutation",
	)<
		{ sessionId: string; ref: { entryId?: string; text?: string; timestamp?: number } },
		{ text: string; images: ImageInput[]; document?: ComposerDocument }
	>({
		sessionId: input.id,
		ref: input.object({
			entryId: input.optional(input.text),
			text: input.optional(input.text),
			timestamp: input.optional(input.number),
		}),
	}),
	/** 读取会话已加载的资源（skills/扩展；设置页展示用） */
	getLoadedResources: ch(
		"session:getLoadedResources",
		"environment",
		"read",
	)<{ sessionId: string }, LoadedResources>({ sessionId: input.id }),
	/**
	 * 有有效频道订阅的**已加载**会话 ID（renderer 内存策略保护用；顺序不构成契约）。
	 * 会话被卸载/关闭后不再返回（backend 快照同步清理）。
	 */
	getChannelSubscriptionSessionIds: ch("session:getChannelSubscriptionSessionIds", "environment", "read")<
		void,
		string[]
	>(),
	/**
	 * 单会话的频道订阅快照（spec D1）。与上面的 GC 查询**语义不同**：这里不按 registry 过滤 ——
	 * 扩展可能早于 registry.add 上报，过滤会让「刚打开就有订阅」的会话查到空集（胶囊闪一下才出现）。
	 */
	getChannelSubscriptions: ch(
		"session:getChannelSubscriptions",
		"environment",
		"read",
	)<{ sessionId: string }, ChannelSubscriptionsSnapshot>({ sessionId: input.id }),
	/** 可用模型列表（providers × models，含 authed/thinkingLevels/imageInput 元数据） */
	listModels: ch("models:list", "environment", "read")<void, AvailableModel[]>(),
	/** @ 补全数据源：项目文件相对路径列表（目录带尾 /） */
	listProjectFiles: ch(
		"project:listFiles",
		"environment",
		"read",
	)<{ cwd?: string }, string[]>({ cwd: input.optional(input.id) }),
	/** 项目信任前置决策（添加项目/切换 draft cwd 时调用，未决则弹窗） */
	ensureProjectTrust: ch(
		"project:ensureTrust",
		"environment",
		"mutation",
	)<{ cwd: string }, boolean>({ cwd: input.id }),
} as const;

/** 社区包域：pi.dev 目录搜索 + 安装/卸载 + 已配置清单 */
export const PACKAGES_CHANNELS = {
	/** 搜索 pi.dev 社区包目录（服务端模糊匹配，50 条/页） */
	searchCatalog: ch(
		"packages:searchCatalog",
		"environment",
		"read",
	)<{ query: string; type?: CatalogPackageType | ""; page?: number }, CatalogSearchResult>({
		query: input.text,
		type: input.optional(input.oneOf("extension", "skill", "prompt", "theme", "")),
		page: input.optional(input.number),
	}),
	/** 安装社区包（npm:<name>，用户级）；成功后热重载非流式活跃会话 */
	installPackage: ch(
		"packages:install",
		"environment",
		"mutation",
	)<{ name: string }, void>({ name: input.text }),
	/** 卸载已配置的包（按 source + scope 移除并持久化）；成功后热重载非流式活跃会话 */
	removePackage: ch(
		"packages:remove",
		"environment",
		"mutation",
	)<{ source: string; scope: "user" | "project" }, void>({
		source: input.text,
		scope: input.oneOf("user", "project"),
	}),
	/** 列出 settings.json 已配置的包（「已安装」态匹配用） */
	listConfiguredPackages: ch("packages:listConfigured", "environment", "read")<
		void,
		ConfiguredPackageInfo[]
	>(),
} as const;

/** MCP 域：官方内置扩展的 mcp.json 读写（连接/展开交给官方；工具运行态走 mcp.tools:changed 事件） */
export const MCP_CHANNELS = {
	/** 读全局 + 项目级 mcp.json（项目级只在受信项目读，与官方 trust-manager 同款） */
	mcpConfigList: ch(
		"mcp:configList",
		"environment",
		"read",
	)<{ cwd?: string }, McpConfigListResult>({ cwd: input.optional(input.id) }),
	/** 新增/编辑一个 server（新建默认写 exposure: "deferred"；新建文件时顶层写 autoEnableCodemode: false） */
	mcpConfigUpsert: ch(
		"mcp:configUpsert",
		"environment",
		"mutation",
	)<McpUpsertInput, McpMutationResult>({
		scope: input.oneOf("user", "project"),
		cwd: input.optional(input.id),
		name: input.id,
		command: input.optional(input.text),
		args: input.optional(input.array(input.text)),
		url: input.optional(input.text),
		description: input.optional(input.text),
		enabled: input.optional(input.boolean),
		exposure: input.optional(input.oneOf("direct", "deferred", "codemode")),
	}),
	/** 重连：reload 会话让官方 mcp 扩展重读配置并重连（面板「重连」入口） */
	mcpConfigReload: ch(
		"mcp:configReload",
		"environment",
		"mutation",
	)<{ cwd?: string }, McpMutationResult>({ cwd: input.optional(input.id) }),
	/** 删除一个 server（按 name + scope）；运行中的会话跳过重连并回报 */
	mcpConfigRemove: ch(
		"mcp:configRemove",
		"environment",
		"mutation",
	)<{ scope: "user" | "project"; cwd?: string; name: string }, McpMutationResult>({
		scope: input.oneOf("user", "project"),
		cwd: input.optional(input.id),
		name: input.text,
	}),
} as const;

/** LAN 观察域：本机服务开关与远程控制开关 */
export const LAN_CHANNELS = {
	/** 读取局域网观察服务状态（URL/二维码只在启用并监听后提供） */
	lanGetStatus: ch("lan:getStatus", "desktop")<void, LanStatus>(),
	/** 启用或停止局域网只读观察服务；启用时轮换访问 token */
	lanSetEnabled: ch("lan:setEnabled", "desktop")<{ enabled: boolean }, LanStatus>(),
	/** 远程控制二级开关（独立于观察开关；未开观察时允许配置但不生效） */
	lanSetRemoteControl: ch("lan:setRemoteControl", "desktop")<{ enabled: boolean }, LanStatus>(),
} as const;

/** 扩展对话框域：renderer 应答（请求/结算/通知为 main→renderer 单向事件，在 index.ts 转发） */
export const EXTENSION_DIALOG_CHANNELS = {
	/** 应答扩展对话框（宿主按 requestId 归属路由，未知 id 静默忽略） */
	respondExtensionDialog: ch(
		"extension-dialog:respond",
		"environment",
		"mutation",
	)<{ requestId: string; answer: ExtensionDialogRespond }, void>({
		requestId: input.id,
		answer: input.union<ExtensionDialogRespond>(
			input.object({ value: input.text }),
			input.object({ confirmed: input.boolean }),
			input.object({ cancelled: input.oneOf(true) }),
		),
	}),
} as const;

/** 设置域：provider 设置 + 模型偏好 + 登录流程 + 权限/上下文/频道开关 + 信任应答 */
export const SETTINGS_CHANNELS = {
	/** 列出 provider（默认只走内置目录+本地缓存；forceNetwork 时联网拉最新模型目录，触发点 = 手动刷新 / 进入模型分类自动刷新） */
	listProviders: ch(
		"settings:listProviders",
		"environment",
		"read",
	)<{ options?: ListProvidersOptions }, ProviderInfo[]>({
		options: input.optional(input.object({ forceNetwork: input.optional(input.boolean) })),
	}),
	saveApiKey: ch(
		"settings:saveApiKey",
		"environment",
		"mutation",
	)<{ providerId: string; key: string }, void>({ providerId: input.id, key: input.text }),
	removeCredential: ch(
		"settings:removeCredential",
		"environment",
		"mutation",
	)<{ providerId: string }, void>({ providerId: input.id }),
	addCustomProvider: ch(
		"settings:addCustomProvider",
		"environment",
		"mutation",
	)<{ input: CustomProviderInput }, void>({ input: input.jsonObject<CustomProviderInput>() }),
	/** 更新自定义 provider（ID 不可改；apiKey 留空保持不变） */
	updateCustomProvider: ch(
		"settings:updateCustomProvider",
		"environment",
		"mutation",
	)<{ input: CustomProviderUpdateInput }, void>({ input: input.jsonObject<CustomProviderUpdateInput>() }),
	/** 从指定上游获取模型；凭证仅在所属执行环境解析和使用。 */
	listUpstreamModels: ch(
		"settings:listUpstreamModels",
		"environment",
		"read",
	)<UpstreamModelsInput, UpstreamModelsResult>({
		providerId: input.optional(input.id),
		baseUrl: input.text,
		api: input.text,
		apiKey: input.optional(input.text),
	}),
	removeCustomProvider: ch(
		"settings:removeCustomProvider",
		"environment",
		"mutation",
	)<{ providerId: string }, void>({ providerId: input.id }),
	/** 内置 provider 的可选 baseUrl 覆写（不写 models，共享官方模型列表）；baseUrl 空串 = 清除覆写回官方 */
	setProviderBaseUrl: ch(
		"settings:setProviderBaseUrl",
		"environment",
		"mutation",
	)<{ providerId: string; baseUrl: string; apiKey?: string }, void>({
		providerId: input.id,
		baseUrl: input.text,
		apiKey: input.optional(input.text),
	}),
	testProvider: ch(
		"settings:testProvider",
		"environment",
		"mutation",
	)<{ providerId: string; modelId?: string }, ProviderTestResult>({
		providerId: input.id,
		modelId: input.optional(input.id),
	}),
	/** 用户级模型偏好：隐藏模型 + 子代理模型/思考深度覆盖 + 执行器偏好 */
	getModelPrefs: ch("settings:getModelPrefs", "environment", "read")<void, ModelPrefs>(),
	/** 设置模型在选择器中的可见性；隐藏不影响已经选中的会话运行 */
	setModelHidden: ch(
		"settings:setModelHidden",
		"environment",
		"mutation",
	)<{ provider: string; modelId: string; hidden: boolean }, ModelPrefs>({
		provider: input.id,
		modelId: input.id,
		hidden: input.boolean,
	}),
	/** 批量设置指定 IDs 的可见性，不改变 provider 默认策略；一次写盘 */
	setModelsHidden: ch(
		"settings:setModelsHidden",
		"environment",
		"mutation",
	)<{ provider: string; modelIds: string[]; hidden: boolean }, ModelPrefs>({
		provider: input.id,
		modelIds: input.array(input.text),
		hidden: input.boolean,
	}),
	/** 设置全源默认可见性，清空该源具体 ID 隐藏/显示名单 */
	setProviderModelsHidden: ch(
		"settings:setProviderModelsHidden",
		"environment",
		"mutation",
	)<{ provider: string; hidden: boolean }, ModelPrefs>({ provider: input.id, hidden: input.boolean }),
	/** 为子代理指定 provider/model；null = 继承父会话模型 */
	setSubagentModel: ch(
		"settings:setSubagentModel",
		"environment",
		"mutation",
	)<{ agent: string; modelRef: string | null }, ModelPrefs>({
		agent: input.id,
		modelRef: input.nullable(input.text),
	}),
	/** 为子代理指定思考深度；null = 跟随 agent 定义（无定义时走 SDK 默认链） */
	setSubagentThinking: ch(
		"settings:setSubagentThinking",
		"environment",
		"mutation",
	)<{ agent: string; level: string | null }, ModelPrefs>({
		agent: input.id,
		level: input.nullable(input.text),
	}),
	/** 内置 subagent 执行器优先；新会话/恢复会话生效 */
	setSubagentPreferBuiltin: ch(
		"settings:setSubagentPreferBuiltin",
		"environment",
		"mutation",
	)<{ enabled: boolean }, ModelPrefs>({ enabled: input.boolean }),
	/** 只列内置与用户级 subagent（设置是全局配置，不绑定项目） */
	listSubagents: ch("settings:listSubagents", "environment", "read")<void, SubagentInfo[]>(),
	/** 启动 provider 交互登录（事件经 onProviderLoginEvent 推送，流程结束 resolve，取消不算错误） */
	startProviderLogin: ch(
		"settings:loginStart",
		"environment",
		"mutation",
	)<{ loginId: string; providerId: string }, LoginResult>({ loginId: input.id, providerId: input.id }),
	/** 取消进行中的登录流程（未知 loginId 静默忽略） */
	cancelProviderLogin: ch(
		"settings:loginCancel",
		"environment",
		"mutation",
	)<{ loginId: string }, void>({ loginId: input.id }),
	/** 应答登录过程中的输入/选择提示（promptId 已被外部取消时静默忽略） */
	respondProviderLogin: ch(
		"settings:loginRespond",
		"environment",
		"mutation",
	)<{ loginId: string; promptId: string; value: string }, void>({
		loginId: input.id,
		promptId: input.id,
		value: input.text,
	}),
	/** 权限请求应答（requestId 全局唯一，gate 遍历幂等） */
	respondPermission: ch(
		"permission:respond",
		"environment",
		"mutation",
	)<{ requestId: string; answer: PermissionAnswer }, void>({
		requestId: input.id,
		answer: input.oneOf("allow", "deny", "allowAlways", "allowDir"),
	}),
	/** 读取权限门控配置（enabled=false = 手改 permissions.json 的隐藏逃生舱态，chip 禁用提示用） */
	getPermissionConfig: ch("permission:getConfig", "environment", "read")<void, PermissionConfigInfo>(),
	/** 读取会话权限模式（default 缺省；关 tab 重开后端已归零，renderer 对齐真值用） */
	getPermissionMode: ch(
		"permission:getMode",
		"environment",
		"read",
	)<{ sessionId: string }, PermissionMode>({ sessionId: input.id }),
	/** 设置会话权限模式（内存态即时生效、不落盘、重启归零） */
	setPermissionMode: ch(
		"permission:setMode",
		"environment",
		"mutation",
	)<{ sessionId: string; mode: PermissionMode }, void>({
		sessionId: input.id,
		mode: input.oneOf("default", "fullAccess"),
	}),
	/** channel-watch 跨会话频道唤醒开关 */
	getChannelWatchConfig: ch("channelWatch:getConfig", "environment", "read")<void, ChannelWatchConfigInfo>(),
	setChannelWatchEnabled: ch(
		"channelWatch:setEnabled",
		"environment",
		"mutation",
	)<{ enabled: boolean }, void>({ enabled: input.boolean }),
	/** 项目信任请求应答（选项下标） */
	respondTrust: ch(
		"trust:respond",
		"environment",
		"mutation",
	)<{ requestId: string; answer: TrustAnswer }, void>({ requestId: input.id, answer: input.number }),
} as const;

/** 应用域：窗口级功能（对话框/背景/更新/tabs/ui-state/git/外链等，多为非透传 handler） */
export const APP_CHANNELS = {
	setTaskNotificationNavigationReady: ch("notifications:navigationReady", "desktop")<
		{ ready: boolean },
		void
	>(),
	setNotificationLanguage: ch("notifications:language", "desktop")<{ language: "zh" | "en" }, void>(),
	testTaskNotification: ch("notifications:test", "desktop")<
		void,
		import("./task-notifications").NotificationSendResult
	>(),
	showComposerEditMenu: ch("composer:editMenu", "desktop")<{ token: string; x: number; y: number }, void>(),
	cancelComposerEditMenu: ch("composer:cancelEditMenu", "desktop")<{ token: string }, void>(),
	validateProjectDirectory: ch(
		"project:validateDirectory",
		"environment",
		"read",
	)<{ path: string }, string>({ path: input.text }),
	/** 弹保存对话框并写文件；用户取消返回 null，成功返回写入路径 */
	saveFileDialog: ch("file:saveDialog", "desktop")<{ defaultName: string; content: string }, string | null>(),
	/** 目录选择对话框（取消返回 null） */
	pickDirectory: ch("project:pickDirectory", "desktop")<void, string | null>(),
	getGitBranch: ch(
		"project:getGitBranch",
		"environment",
		"read",
	)<{ cwd: string }, string | null>({ cwd: input.id }),
	listGitBranches: ch(
		"project:listGitBranches",
		"environment",
		"read",
	)<{ cwd: string }, GitBranches>({ cwd: input.id }),
	/** 切换分支；返回切换后的当前分支（失败抛错） */
	checkoutBranch: ch(
		"project:checkoutBranch",
		"environment",
		"mutation",
	)<{ cwd: string; branch: string }, string>({ cwd: input.id, branch: input.text }),
	/** 用系统浏览器打开链接（仅 http(s)，防 file:// 协议滥用） */
	openExternal: ch("app:openExternal", "desktop")<{ url: string }, void>(),
	/** 解析文件路径为绝对路径（相对/`~`/`file://`/带 `:行:列` 锚点均可；不存在抛错） */
	resolvePath: ch(
		"app:resolvePath",
		"environment",
		"read",
	)<{ target: string; cwd: string | null }, string>({ target: input.text, cwd: input.nullable(input.id) }),
	/** 用系统默认应用打开文件（路径解析同上；打开失败把系统报错抛给渲染端） */
	openPath: ch("app:openPath", "desktop")<{ target: string; cwd: string | null }, void>(),
	/** 在系统文件管理器中显示该文件（macOS = 访达；路径解析同上） */
	revealPath: ch("app:revealPath", "desktop")<{ target: string; cwd: string | null }, void>(),
	/** 本机路径是文件还是目录（粘贴/拖放的引用选图标；按输入顺序返回，非绝对路径或读取失败按文件算） */
	pathKinds: ch("app:pathKinds", "desktop")<{ paths: string[] }, Array<"file" | "directory">>(),
	/** 应用信息（版本/运行时版本/仓库地址，设置关于页用） */
	getAppInfo: ch("app:getInfo", "desktop")<void, AppInfo>(),
	/** 日常空间工作台目录（懒创建后返回；日常会话的固定 cwd） */
	getDailyDir: ch("app:getDailyDir", "environment", "read")<void, string>(),
	/** 读取持久化 UI 状态（上次使用的模型/思考级别/主题/背景；无数据返回 null） */
	loadEnvironmentUiState: ch("environmentUi:load", "desktop")<void, EnvironmentUiState | null>(),
	saveEnvironmentUiState: ch("environmentUi:save", "desktop")<{ state: EnvironmentUiState }, void>(),
	loadUiState: ch("uiState:load", "desktop")<void, UiState | null>(),
	/** 持久化 UI 状态（主进程合并写入 userData/ui-state.json，传补丁即可） */
	saveUiState: ch("uiState:save", "desktop")<{ state: Partial<UiState> }, void>(),
	/** 弹图选框选背景图并拷贝进 userData/backgrounds/；取消返回 null */
	pickBackgroundImage: ch("background:pick", "desktop")<void, string | null>(),
	/** 检查更新（纯检查：发现新版只提示不下载） */
	checkForUpdates: ch("update:check", "desktop")<void, void>(),
	/** 下载更新（已发现新版→下载；未发现→先检查）；仅用户显式点击触发 */
	downloadUpdate: ch("update:download", "desktop")<void, void>(),
	/** 重启并安装已下载的更新 */
	installUpdate: ch("update:install", "desktop")<void, void>(),
	/** 上一次安装交接是否已观察到目标版本启动（不推断安装器退出结果） */
	getUpdateDiagnostics: ch("update:diagnostics", "desktop")<void, UpdateDiagnosticsInfo>(),
	/** 用户选择路径后导出专用更新诊断；取消返回 null，不含会话/认证文件 */
	exportUpdateDiagnostics: ch("update:exportDiagnostics", "desktop")<void, string | null>(),
	/** 渲染端声明「退出确认由我接管」（App 挂载时置位）——未接管时 main 关窗直接放行 */
	setQuitGuard: ch("app:setQuitGuard", "desktop")<{ enabled: boolean }, void>(),
	/** 渲染端回执「退出确认窗已上屏」→ main 撤掉兑底计时（超时 = 渲染进程卡死，直接放行退出） */
	quitDialogShown: ch("app:quitDialogShown", "desktop")<void, void>(),
	/** 用户在退出确认弹窗点了「退出」→ main 置 quitting 后真退 */
	confirmQuit: ch("app:confirmQuit", "desktop")<void, void>(),
} as const;

/** UI 插件域：配置读写 / 列表 / 构建 / 代码读取 / 目录打开（参数校验在 handler 内） */
export const UI_PLUGINS_CHANNELS = {
	/** 读 UI 插件全局配置（总开关/启用信任表/槽位指派） */
	uiPluginsGetConfig: ch("uiPlugins:getConfig", "desktop")<void, UiPluginsConfig>(),
	/** 设 UI 插件全局总开关 */
	uiPluginsSetEnabled: ch("uiPlugins:setEnabled", "desktop")<{ enabled: boolean }, void>(),
	/** 列 UI 插件（含 enabled/trusted/buildError/invalidReason） */
	uiPluginsList: ch("uiPlugins:list", "desktop")<void, UiPluginInfo[]>(),
	/** 读插件构建产物（name 必须是扫描到的合法插件名，禁路径） */
	uiPluginsReadCode: ch("uiPlugins:readCode", "desktop")<
		{ name: string },
		{ manifest: UiPluginManifest; code: string } | { error: string }
	>(),
	/** 启用/停用单个插件（启用=信任，同步落盘） */
	uiPluginsSetPluginEnabled: ch("uiPlugins:setPluginEnabled", "desktop")<
		{ name: string; enabled: boolean },
		void
	>(),
	/** 槽位指派（pluginName=null 取消指派） */
	uiPluginsAssignSlot: ch("uiPlugins:assignSlot", "desktop")<
		{ slot: string; pluginName: string | null },
		void
	>(),
	/** 重新构建插件（构建失败返回错误信息，旧产物保留） */
	uiPluginsRebuild: ch("uiPlugins:rebuild", "desktop")<
		{ name: string },
		{ ok: true } | { ok: false; error: string }
	>(),
	/** 打开插件目录（不传 name 开根目录；shell.openPath） */
	uiPluginsOpenDir: ch("uiPlugins:openDir", "desktop")<{ name?: string }, void>(),
} as const;

/** Desktop-owned connection control; never forwarded to a remote business handler. */
export const REMOTE_CHANNELS = {
	remoteListSshAliases: ch("remote:listSshAliases", "desktop")<void, SshAliasDiscovery>(),
	remoteAuthGuide: ch("remote:authGuide", "desktop")<{ environment: EnvironmentRef }, RemoteAuthGuide>(),
	remoteStopService: ch("remote:stopService", "desktop")<void, RemoteConnectionStatus>(),
	remotePreflight: ch("remote:preflight", "desktop")<{ alias: string }, SshPreflight>(),
	remoteForget: ch("remote:forget", "desktop")<void, RemoteConnectionStatus>(),
	remoteCheckOperation: ch("remote:checkOperation", "desktop")<{ operationId: string }, MutationReceipt>(),
	remoteDismissOperation: ch("remote:dismissOperation", "desktop")<{ operationId: string }, void>(),
	remoteGetStatus: ch("remote:status", "desktop")<void, RemoteConnectionStatus>(),
	remotePrepareInstall: ch("remote:prepareInstall", "desktop")<{ alias: string }, RemoteConnectionStatus>(),
	remoteInstall: ch("remote:install", "desktop")<{ token: string }, RemoteConnectionStatus>(),
	remoteConnect: ch("remote:connect", "desktop")<{ alias: string }, RemoteConnectionStatus>(),
	remoteDisconnect: ch("remote:disconnect", "desktop")<void, RemoteConnectionStatus>(),
} as const;

/** 已表化通道全集（分批迁移，终态 = 全部 invoke 通道） */
export const STORAGE_STARTUP_CHANNELS = {
	storageStartupGet: ch("storageStartup:get", "desktop")<void, StorageStartupState>(),
	storageStartupAct: ch(
		"storageStartup:act",
		"desktop",
	)<{ action: StorageStartupAction }, void>({
		action: input.oneOf("copy", "empty", "adopt", "retry", "cancel", "exit"),
	}),
} as const;

export const CHANNEL_TABLE = {
	...STORAGE_STARTUP_CHANNELS,
	...REMOTE_CHANNELS,
	...SESSION_CHANNELS,
	...SETTINGS_CHANNELS,
	...PACKAGES_CHANNELS,
	...MCP_CHANNELS,
	...APP_CHANNELS,
	...LAN_CHANNELS,
	...EXTENSION_DIALOG_CHANNELS,
	...UI_PLUGINS_CHANNELS,
} as const;

export type ChannelTable = typeof CHANNEL_TABLE;

/** invoke API 形状推导（表 key = PiApi 方法名；void 参数 → 零参调用） */
export type InvokeApi<T extends Record<string, AnyChannelDef>> = {
	[K in keyof T]: T[K]["args"] extends void
		? () => Promise<T[K]["ret"]>
		: (args: T[K]["args"]) => Promise<T[K]["ret"]>;
};

/** main 侧 handler 形状（handler 构造点 satisfies 校验 args/ret） */
export type InvokeHandlers<T extends Record<string, AnyChannelDef>> = {
	[K in keyof T]: T[K]["args"] extends void
		? () => T[K]["ret"] | Promise<T[K]["ret"]>
		: (args: T[K]["args"]) => T[K]["ret"] | Promise<T[K]["ret"]>;
};

/** 表 → 通道字符串映射（值维度） */
function channelsFromTable<T extends Record<string, AnyChannelDef>>(
	table: T,
): { [K in keyof T]: T[K]["channel"] } {
	return Object.fromEntries(Object.entries(table).map(([key, def]) => [key, def.channel])) as {
		[K in keyof T]: T[K]["channel"];
	};
}

/** Payload is a type-only slot like invoke args/ret; void requires an explicit runtime marker. */
function subscription<P, S extends ChannelScope = "environment">(scope: S = "environment" as S) {
	return <const A extends string, const C extends string>(
		alias: A,
		channel: C,
		...noPayload: [P] extends [ReturnType<() => void>] ? [true] : []
	) =>
		({ alias, channel, scope, noPayload: noPayload[0] ?? false }) as {
			alias: A;
			channel: C;
			payload: P;
			scope: S;
			noPayload: boolean;
		};
}

/** Sole subscription definition: API key + explicit legacy alias + channel + payload type. */
export const SUBSCRIPTION_TABLE = {
	onTaskNotificationClick: subscription<import("./task-notifications").TaskNotificationClick, "desktop">(
		"desktop",
	)("TaskNotificationClick", "notifications:clicked"),
	onStorageStartup: subscription<StorageStartupState, "desktop">("desktop")(
		"StorageStartup",
		"storageStartup:changed",
	),
	onRemoteConnectionStatus: subscription<RemoteConnectionStatus, "desktop">("desktop")(
		"RemoteConnectionStatus",
		"remote:statusChanged",
	),
	onProviderLoginEvent: subscription<LoginEventPayload>()("SettingsLoginEvent", "settings:loginEvent"),
	onMcpServersChanged: subscription<McpServersChangedPayload>()("McpServersChanged", "mcp:serversChanged"),
	onChannelSubscriptionsChanged: subscription<ChannelSubscriptionsSnapshot>()(
		"ChannelSubscriptionsChanged",
		"channel:subscriptionsChanged",
	),
	onUiPluginsEvent: subscription<UiPluginsEventPayload, "desktop">("desktop")(
		"UiPluginsEvent",
		"uiPlugins:event",
	),
	onQuitRequested: subscription<void, "desktop">("desktop")("QuitRequested", "app:quit-requested", true),
	onUpdateEvent: subscription<UpdateState, "desktop">("desktop")("UpdateEvent", "update:event"),
	onEvent: subscription<SessionEventEnvelope>()("Event", "pi:event"),
	onPermissionRequest: subscription<PermissionRequest>()("PermissionRequest", "pi:permission-request"),
	onPermissionResolved: subscription<PermissionResolved>()("PermissionResolved", "pi:permission-resolved"),
	onTrustResolved: subscription<TrustResolved>()("TrustResolved", "pi:trustResolved"),
	onTrustRequest: subscription<TrustRequest>()("TrustRequest", "pi:trust-request"),
	onExtensionDialogRequest: subscription<ExtensionDialogRequest>()(
		"ExtensionDialogRequest",
		"pi:extension-dialog-request",
	),
	onExtensionDialogResolved: subscription<ExtensionDialogResolved>()(
		"ExtensionDialogResolved",
		"pi:extension-dialog-resolved",
	),
	onExtensionNotify: subscription<ExtensionNotifyEvent>()("ExtensionNotify", "pi:extension-notify"),
	onExtensionEditorText: subscription<ExtensionEditorTextEvent>()(
		"ExtensionEditorText",
		"pi:extension-editor-text",
	),
} as const;

export type SubscriptionApi<T extends Record<string, { payload: unknown }>> = {
	[K in keyof T]: (
		cb: T[K]["payload"] extends void ? () => void : (payload: T[K]["payload"]) => void,
	) => () => void;
};
export type SubscriptionChannel = (typeof SUBSCRIPTION_TABLE)[keyof typeof SUBSCRIPTION_TABLE]["channel"];
export type SubscriptionPayload<C extends SubscriptionChannel> = {
	[K in keyof typeof SUBSCRIPTION_TABLE as (typeof SUBSCRIPTION_TABLE)[K]["channel"]]: (typeof SUBSCRIPTION_TABLE)[K]["payload"];
}[C];

const EVENT_CHANNELS = Object.fromEntries(
	Object.values(SUBSCRIPTION_TABLE).map((def) => [def.alias, def.channel]),
) as {
	[K in keyof typeof SUBSCRIPTION_TABLE as (typeof SUBSCRIPTION_TABLE)[K]["alias"]]: (typeof SUBSCRIPTION_TABLE)[K]["channel"];
};

/** 全通道字符串常量：main→renderer 事件通道 + 表化 invoke（key = PiApi 方法名） */
export const IpcChannels = Object.freeze({
	...EVENT_CHANNELS,
	...channelsFromTable(CHANNEL_TABLE),
});
