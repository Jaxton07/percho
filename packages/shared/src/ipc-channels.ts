import type { ExtensionDialogRespond } from "./extension-dialog";
import type { LanStatus } from "./lan";
import type { CatalogPackageType, CatalogSearchResult, ConfiguredPackageInfo } from "./packages";
import type {
	AppInfo,
	AvailableModel,
	ChannelWatchConfigInfo,
	ContextManagerConfigInfo,
	ContextManagerMode,
	ContextUsageInfo,
	CreateSessionOptions,
	GitBranches,
	ImageInput,
	LoadedResources,
	PermissionAnswer,
	PermissionConfigInfo,
	PermissionMode,
	QueuedMessages,
	QuotaInfo,
	SavedTabs,
	SessionMessage,
	SessionMeta,
	SessionStats,
	SlashCommandInfo,
	TrustAnswer,
	UiState,
} from "./session";
import type {
	CustomProviderInput,
	CustomProviderUpdateInput,
	ListProvidersOptions,
	LoginResult,
	ModelPrefs,
	ProviderInfo,
	ProviderTestResult,
	SubagentInfo,
} from "./settings";
import type { TodoItem } from "./todo";
import type { UiPluginInfo, UiPluginManifest, UiPluginsConfig } from "./ui-plugins";

/**
 * IPC invoke 通道单一事实源（D5）：key（= PiApi 方法名）→ 通道字符串 + 参数/返回类型。
 *
 * 约定：
 * - 参数统一「单对象」形态（无参通道 args = void）；main→renderer 单向事件通道不在此表
 *   （见下方 EVENT_CHANNELS，send-only 无 invoke 返回语义）
 * - ch("domain:action")<{...args}, Ret>()：通道字面量只写一次，运行时值仅 { channel }
 * - main 侧经 registerInvokeHandlers(子表, handlers) 注册；preload 对 CHANNEL_TABLE 循环注册
 */

/** 通道定义：channel 字面量 + args/ret（args/ret 仅类型占位，运行时不存在） */
export interface ChannelDef<C extends string = string, A = void, R = unknown> {
	channel: C;
	args: A;
	ret: R;
}

/** 已知 channel 字面量的 args/ret 构造器（第二段显式泛型） */
export type ChannelCtor<C extends string> = <A, R>() => ChannelDef<C, A, R>;

/** ch("domain:action")<Args, Ret>() —— 通道字面量（第一段推断保留）+ args/ret（第二段显式）；运行时值仅 { channel } */
export function ch<const C extends string>(channel: C): ChannelCtor<C> {
	const ctor = () => ({ channel });
	return ctor as ChannelCtor<C>;
}

/** 泛型容器最小约束（args/ret 任意；channel 字面量保留） */
export type AnyChannelDef = ChannelDef<string, any, any>;

/** 会话域：生命周期/提示/导出/fork/撤回 + 模型列表 */
export const SESSION_CHANNELS = {
	/** 建会话（cwd 必选；模型/思考级别可选，缺省用全局默认） */
	createSession: ch("session:create")<{ options: CreateSessionOptions }, SessionMeta>(),
	/** 列当前目录历史会话（排除活跃） */
	listSessions: ch("session:list")<{ cwd?: string }, SessionMeta[]>(),
	/** opencode-go 套餐额度（全局；无 key/无订阅 null） */
	getQuota: ch("session:getQuota")<void, QuotaInfo | null>(),
	/** 设置当前会话模型（同步 SDK；失败 renderer 回滚） */
	setModel: ch("session:setModel")<{ sessionId: string; provider: string; modelId: string }, void>(),
	/** 跨全部项目目录枚举历史会话（项目管理页用，含活跃） */
	listAllSessions: ch("session:listAll")<void, SessionMeta[]>(),
	openSession: ch("session:open")<{ filePath: string }, SessionMeta>(),
	closeSession: ch("session:close")<{ sessionId: string }, void>(),
	/** 删除会话（含磁盘 jsonl 文件，不可恢复） */
	deleteSession: ch("session:delete")<{ sessionId: string; sessionFile?: string }, void>(),
	/** 发送消息；images 为随消息附带的图片（base64） */
	prompt: ch("session:prompt")<{ sessionId: string; text: string; images?: ImageInput[] }, void>(),
	abort: ch("session:abort")<{ sessionId: string }, void>(),
	setThinkingLevel: ch("session:setThinkingLevel")<{ sessionId: string; level: string }, void>(),
	/** 读取会话历史消息（打开历史会话时回放） */
	getSessionMessages: ch("session:getMessages")<{ sessionId: string }, SessionMessage[]>(),
	/** 读取会话当前 todo 列表（无则空数组） */
	getTodos: ch("session:getTodos")<{ sessionId: string }, TodoItem[]>(),
	compact: ch("session:compact")<{ sessionId: string; customInstructions?: string }, void>(),
	getStats: ch("session:stats")<{ sessionId: string }, SessionStats>(),
	/** 当前模型上下文使用（无会话或未知时返回 null） */
	getContextUsage: ch("session:getContextUsage")<{ sessionId: string }, ContextUsageInfo | null>(),
	/** 清空运行中排队的消息，返回被清内容（还原草稿用） */
	clearQueue: ch("session:clearQueue")<{ sessionId: string }, QueuedMessages>(),
	getFollowUpMessages: ch("session:getFollowUpMessages")<{ sessionId: string }, string[]>(),
	listSlashCommands: ch("session:listSlashCommands")<{ sessionId: string }, SlashCommandInfo[]>(),
	/** 无会话斜杠命令列表（draft 新会话按 cwd 拉取；信任未决不弹窗，只含用户级资源） */
	listSlashCommandsForCwd: ch("session:listSlashCommandsForCwd")<{ cwd?: string }, SlashCommandInfo[]>(),
	setSessionName: ch("session:setName")<{ sessionId: string; name: string }, void>(),
	exportSession: ch("session:export")<{ sessionId: string; format: "html" | "jsonl" }, string>(),
	/** fork：以 ref 定位分支点新建会话 */
	forkSession: ch("session:fork")<
		{ sessionId: string; ref: { entryId?: string; text?: string } },
		SessionMeta
	>(),
	/** 撤回用户消息（回退到该消息之前，内容放回输入框） */
	recallMessage: ch("session:recall")<
		{ sessionId: string; ref: { entryId?: string; text?: string; timestamp?: number } },
		{ text: string; images: ImageInput[] }
	>(),
	/** 读取会话已加载的资源（skills/扩展；设置页展示用） */
	getLoadedResources: ch("session:getLoadedResources")<{ sessionId: string }, LoadedResources>(),
	/** 可用模型列表（providers × models，含 authed/thinkingLevels/imageInput 元数据） */
	listModels: ch("models:list")<void, AvailableModel[]>(),
	/** @ 补全数据源：项目文件相对路径列表（目录带尾 /） */
	listProjectFiles: ch("project:listFiles")<{ cwd?: string }, string[]>(),
	/** 项目信任前置决策（添加项目/切换 draft cwd 时调用，未决则弹窗） */
	ensureProjectTrust: ch("project:ensureTrust")<{ cwd: string }, boolean>(),
} as const;

/** 社区包域：pi.dev 目录搜索 + 安装/卸载 + 已配置清单 */
export const PACKAGES_CHANNELS = {
	/** 搜索 pi.dev 社区包目录（服务端模糊匹配，50 条/页） */
	searchCatalog: ch("packages:searchCatalog")<
		{ query: string; type?: CatalogPackageType | ""; page?: number },
		CatalogSearchResult
	>(),
	/** 安装社区包（npm:<name>，用户级）；成功后热重载非流式活跃会话 */
	installPackage: ch("packages:install")<{ name: string }, void>(),
	/** 卸载已配置的包（按 source + scope 移除并持久化）；成功后热重载非流式活跃会话 */
	removePackage: ch("packages:remove")<{ source: string; scope: "user" | "project" }, void>(),
	/** 列出 settings.json 已配置的包（「已安装」态匹配用） */
	listConfiguredPackages: ch("packages:listConfigured")<void, ConfiguredPackageInfo[]>(),
} as const;

/** LAN 观察域：本机服务开关与远程控制开关 */
export const LAN_CHANNELS = {
	/** 读取局域网观察服务状态（URL/二维码只在启用并监听后提供） */
	lanGetStatus: ch("lan:getStatus")<void, LanStatus>(),
	/** 启用或停止局域网只读观察服务；启用时轮换访问 token */
	lanSetEnabled: ch("lan:setEnabled")<{ enabled: boolean }, LanStatus>(),
	/** 远程控制二级开关（独立于观察开关；未开观察时允许配置但不生效） */
	lanSetRemoteControl: ch("lan:setRemoteControl")<{ enabled: boolean }, LanStatus>(),
} as const;

/** 扩展对话框域：renderer 应答（请求/结算/通知为 main→renderer 单向事件，在 index.ts 转发） */
export const EXTENSION_DIALOG_CHANNELS = {
	/** 应答扩展对话框（宿主按 requestId 归属路由，未知 id 静默忽略） */
	respondExtensionDialog: ch("extension-dialog:respond")<
		{ requestId: string; answer: ExtensionDialogRespond },
		void
	>(),
} as const;

/** 设置域：provider 设置 + 模型偏好 + 登录流程 + 权限/上下文/频道开关 + 信任应答 */
export const SETTINGS_CHANNELS = {
	/** 列出 provider（默认只走内置目录+本地缓存；forceNetwork 时联网拉最新模型目录） */
	listProviders: ch("settings:listProviders")<{ options?: ListProvidersOptions }, ProviderInfo[]>(),
	saveApiKey: ch("settings:saveApiKey")<{ providerId: string; key: string }, void>(),
	removeCredential: ch("settings:removeCredential")<{ providerId: string }, void>(),
	addCustomProvider: ch("settings:addCustomProvider")<{ input: CustomProviderInput }, void>(),
	/** 更新自定义 provider（ID 不可改；apiKey 留空保持不变） */
	updateCustomProvider: ch("settings:updateCustomProvider")<{ input: CustomProviderUpdateInput }, void>(),
	removeCustomProvider: ch("settings:removeCustomProvider")<{ providerId: string }, void>(),
	/** 内置 provider 的可选 baseUrl 覆写（不写 models，共享官方模型列表）；baseUrl 空串 = 清除覆写回官方 */
	setProviderBaseUrl: ch("settings:setProviderBaseUrl")<
		{ providerId: string; baseUrl: string; apiKey?: string },
		void
	>(),
	testProvider: ch("settings:testProvider")<{ providerId: string; modelId?: string }, ProviderTestResult>(),
	/** 用户级模型偏好：隐藏模型 + 子代理模型/思考深度覆盖 + 执行器偏好 */
	getModelPrefs: ch("settings:getModelPrefs")<void, ModelPrefs>(),
	/** 设置模型在选择器中的可见性；隐藏不影响已经选中的会话运行 */
	setModelHidden: ch("settings:setModelHidden")<
		{ provider: string; modelId: string; hidden: boolean },
		ModelPrefs
	>(),
	/** 批量设置一组模型可见性（一键全隐藏/全显示某 provider 的全部模型）；一次写盘 */
	setModelsHidden: ch("settings:setModelsHidden")<
		{ provider: string; modelIds: string[]; hidden: boolean },
		ModelPrefs
	>(),
	/** 为子代理指定 provider/model；null = 继承父会话模型 */
	setSubagentModel: ch("settings:setSubagentModel")<{ agent: string; modelRef: string | null }, ModelPrefs>(),
	/** 为子代理指定思考深度；null = 跟随 agent 定义（无定义时走 SDK 默认链） */
	setSubagentThinking: ch("settings:setSubagentThinking")<
		{ agent: string; level: string | null },
		ModelPrefs
	>(),
	/** 内置 subagent 执行器优先；新会话/恢复会话生效 */
	setSubagentPreferBuiltin: ch("settings:setSubagentPreferBuiltin")<{ enabled: boolean }, ModelPrefs>(),
	/** 只列内置与用户级 subagent（设置是全局配置，不绑定项目） */
	listSubagents: ch("settings:listSubagents")<void, SubagentInfo[]>(),
	/** 启动 provider 交互登录（事件经 onProviderLoginEvent 推送，流程结束 resolve，取消不算错误） */
	startProviderLogin: ch("settings:loginStart")<{ loginId: string; providerId: string }, LoginResult>(),
	/** 取消进行中的登录流程（未知 loginId 静默忽略） */
	cancelProviderLogin: ch("settings:loginCancel")<{ loginId: string }, void>(),
	/** 应答登录过程中的输入/选择提示（promptId 已被外部取消时静默忽略） */
	respondProviderLogin: ch("settings:loginRespond")<
		{ loginId: string; promptId: string; value: string },
		void
	>(),
	/** 权限请求应答（requestId 全局唯一，gate 遍历幂等） */
	respondPermission: ch("permission:respond")<{ requestId: string; answer: PermissionAnswer }, void>(),
	/** 读取权限门控配置（enabled=false = 手改 permissions.json 的隐藏逃生舱态，chip 禁用提示用） */
	getPermissionConfig: ch("permission:getConfig")<void, PermissionConfigInfo>(),
	/** 读取会话权限模式（default 缺省；关 tab 重开后端已归零，renderer 对齐真值用） */
	getPermissionMode: ch("permission:getMode")<{ sessionId: string }, PermissionMode>(),
	/** 设置会话权限模式（内存态即时生效、不落盘、重启归零） */
	setPermissionMode: ch("permission:setMode")<{ sessionId: string; mode: PermissionMode }, void>(),
	/** 读取上下文管理模式（evaporation / off 二态派生） */
	getContextManagerConfig: ch("contextManager:getConfig")<void, ContextManagerConfigInfo>(),
	setContextManagerMode: ch("contextManager:setMode")<{ mode: ContextManagerMode }, void>(),
	/** channel-watch 跨会话频道唤醒开关 */
	getChannelWatchConfig: ch("channelWatch:getConfig")<void, ChannelWatchConfigInfo>(),
	setChannelWatchEnabled: ch("channelWatch:setEnabled")<{ enabled: boolean }, void>(),
	/** 项目信任请求应答（选项下标） */
	respondTrust: ch("trust:respond")<{ requestId: string; answer: TrustAnswer }, void>(),
} as const;

/** 应用域：窗口级功能（对话框/背景/更新/tabs/ui-state/git/外链等，多为非透传 handler） */
export const APP_CHANNELS = {
	/** 弹保存对话框并写文件；用户取消返回 null，成功返回写入路径 */
	saveFileDialog: ch("file:saveDialog")<{ defaultName: string; content: string }, string | null>(),
	/** 目录选择对话框（取消返回 null） */
	pickDirectory: ch("project:pickDirectory")<void, string | null>(),
	getGitBranch: ch("project:getGitBranch")<{ cwd: string }, string | null>(),
	listGitBranches: ch("project:listGitBranches")<{ cwd: string }, GitBranches>(),
	/** 切换分支；返回切换后的当前分支（失败抛错） */
	checkoutBranch: ch("project:checkoutBranch")<{ cwd: string; branch: string }, string>(),
	/** 用系统浏览器打开链接（仅 http(s)，防 file:// 协议滥用） */
	openExternal: ch("app:openExternal")<{ url: string }, void>(),
	/** 应用信息（版本/运行时版本/仓库地址，设置关于页用） */
	getAppInfo: ch("app:getInfo")<void, AppInfo>(),
	/** 日常空间工作台目录（懒创建后返回；日常会话的固定 cwd） */
	getDailyDir: ch("app:getDailyDir")<void, string>(),
	/** 读取持久化的顶栏 tabs（无数据返回 null） */
	loadTabs: ch("tabs:load")<void, SavedTabs | null>(),
	/** 持久化顶栏 tabs（主进程写 userData/tabs.json） */
	saveTabs: ch("tabs:save")<{ tabs: SavedTabs }, void>(),
	/** 读取持久化 UI 状态（上次使用的模型/思考级别/主题/背景；无数据返回 null） */
	loadUiState: ch("uiState:load")<void, UiState | null>(),
	/** 持久化 UI 状态（主进程合并写入 userData/ui-state.json，传补丁即可） */
	saveUiState: ch("uiState:save")<{ state: Partial<UiState> }, void>(),
	/** 弹图选框选背景图并拷贝进 userData/backgrounds/；取消返回 null */
	pickBackgroundImage: ch("background:pick")<void, string | null>(),
	/** 检查更新（纯检查：发现新版只提示不下载） */
	checkForUpdates: ch("update:check")<void, void>(),
	/** 下载更新（已发现新版→下载；未发现→先检查）；仅用户显式点击触发 */
	downloadUpdate: ch("update:download")<void, void>(),
	/** 重启并安装已下载的更新 */
	installUpdate: ch("update:install")<void, void>(),
} as const;

/** UI 插件域：配置读写 / 列表 / 构建 / 代码读取 / 目录打开（参数校验在 handler 内） */
export const UI_PLUGINS_CHANNELS = {
	/** 读 UI 插件全局配置（总开关/启用信任表/槽位指派） */
	uiPluginsGetConfig: ch("uiPlugins:getConfig")<void, UiPluginsConfig>(),
	/** 设 UI 插件全局总开关 */
	uiPluginsSetEnabled: ch("uiPlugins:setEnabled")<{ enabled: boolean }, void>(),
	/** 列 UI 插件（含 enabled/trusted/buildError/invalidReason） */
	uiPluginsList: ch("uiPlugins:list")<void, UiPluginInfo[]>(),
	/** 读插件构建产物（name 必须是扫描到的合法插件名，禁路径） */
	uiPluginsReadCode: ch("uiPlugins:readCode")<
		{ name: string },
		{ manifest: UiPluginManifest; code: string } | { error: string }
	>(),
	/** 启用/停用单个插件（启用=信任，同步落盘） */
	uiPluginsSetPluginEnabled: ch("uiPlugins:setPluginEnabled")<{ name: string; enabled: boolean }, void>(),
	/** 槽位指派（pluginName=null 取消指派） */
	uiPluginsAssignSlot: ch("uiPlugins:assignSlot")<{ slot: string; pluginName: string | null }, void>(),
	/** 重新构建插件（构建失败返回错误信息，旧产物保留） */
	uiPluginsRebuild: ch("uiPlugins:rebuild")<{ name: string }, { ok: true } | { ok: false; error: string }>(),
	/** 打开插件目录（不传 name 开根目录；shell.openPath） */
	uiPluginsOpenDir: ch("uiPlugins:openDir")<{ name?: string }, void>(),
} as const;

/** 已表化通道全集（分批迁移，终态 = 全部 invoke 通道） */
export const CHANNEL_TABLE = {
	...SESSION_CHANNELS,
	...SETTINGS_CHANNELS,
	...PACKAGES_CHANNELS,
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

/** main → renderer 单向事件通道（send-only；preload 订阅与 main 推送共用，不进 invoke 表） */
const EVENT_CHANNELS = {
	Event: "pi:event",
	PermissionRequest: "pi:permission-request",
	/** 权限请求已裁决（含 LAN 远程应答；桌面端据此撤卡） */
	PermissionResolved: "pi:permission-resolved",
	/** 项目信任请求（会话创建前） */
	TrustRequest: "pi:trust-request",
	/** 扩展对话框请求/结算 + notify + 草稿预填（issue #45，GUI-only 不进 LAN） */
	ExtensionDialogRequest: "pi:extension-dialog-request",
	ExtensionDialogResolved: "pi:extension-dialog-resolved",
	ExtensionNotify: "pi:extension-notify",
	ExtensionEditorText: "pi:extension-editor-text",
	/** 登录流程事件（event/prompt/prompt-cancel） */
	SettingsLoginEvent: "settings:loginEvent",
	/** 更新状态 */
	UpdateEvent: "update:event",
	/** UI 插件事件（changed/config） */
	UiPluginsEvent: "uiPlugins:event",
} as const;

/** 全通道字符串常量：main→renderer 事件通道 + 表化 invoke（key = PiApi 方法名） */
export const IpcChannels = Object.freeze({
	...EVENT_CHANNELS,
	...channelsFromTable(CHANNEL_TABLE),
});
