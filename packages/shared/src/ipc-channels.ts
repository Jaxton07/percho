import type { CatalogPackageType, CatalogSearchResult } from "./packages";
import type {
	AvailableModel,
	ContextUsageInfo,
	CreateSessionOptions,
	ImageInput,
	LoadedResources,
	QueuedMessages,
	QuotaInfo,
	SessionMessage,
	SessionMeta,
	SessionStats,
	SlashCommandInfo,
} from "./session";
import type { TodoItem } from "./todo";

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
} as const;

/** 应用域：窗口级功能（对话框/背景/更新/tabs/ui-state/git/外链等，多为非透传 handler） */
export const APP_CHANNELS = {
	/** 弹保存对话框并写文件；用户取消返回 null，成功返回写入路径 */
	saveFileDialog: ch("file:saveDialog")<{ defaultName: string; content: string }, string | null>(),
} as const;

/** 已表化通道全集（分批迁移，终态 = 全部 invoke 通道） */
export const CHANNEL_TABLE = {
	...SESSION_CHANNELS,
	...PACKAGES_CHANNELS,
	...APP_CHANNELS,
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

/**
 * 迁移期：尚未表化的 invoke 通道（终态删除；每批迁移从这移进上面的子表）。
 * key 保持旧 PascalCase 形态以最小化未迁移域 diff。
 */
const LEGACY_INVOKE_CHANNELS = {
	PackagesInstall: "packages:install",
	PackagesRemove: "packages:remove",
	PackagesListConfigured: "packages:listConfigured",
	SettingsListProviders: "settings:listProviders",
	SettingsSaveApiKey: "settings:saveApiKey",
	SettingsRemoveCredential: "settings:removeCredential",
	SettingsAddCustomProvider: "settings:addCustomProvider",
	SettingsUpdateCustomProvider: "settings:updateCustomProvider",
	SettingsRemoveCustomProvider: "settings:removeCustomProvider",
	SettingsSetProviderBaseUrl: "settings:setProviderBaseUrl",
	SettingsTestProvider: "settings:testProvider",
	/** 用户级模型偏好：隐藏模型 + 子代理模型/思考深度覆盖 + 执行器偏好 */
	SettingsGetModelPrefs: "settings:getModelPrefs",
	SettingsSetModelHidden: "settings:setModelHidden",
	SettingsSetModelsHidden: "settings:setModelsHidden",
	SettingsSetSubagentModel: "settings:setSubagentModel",
	SettingsSetSubagentThinking: "settings:setSubagentThinking",
	SettingsSetSubagentPreferBuiltin: "settings:setSubagentPreferBuiltin",
	/** 只列内置与用户级 subagent（设置是全局配置，不绑定项目） */
	SettingsListSubagents: "settings:listSubagents",
	/** provider 交互登录（OAuth / api_key）；loginId 由 renderer 生成用于事件归属 */
	SettingsLoginStart: "settings:loginStart",
	SettingsLoginCancel: "settings:loginCancel",
	SettingsLoginRespond: "settings:loginRespond",
	LanGetStatus: "lan:getStatus",
	LanSetEnabled: "lan:setEnabled",
	/** 局域网远程控制二级开关（M2；默认关闭，开观察 ≠ 开控制）。 */
	LanSetRemoteControl: "lan:setRemoteControl",
	PermissionRespond: "permission:respond",
	/** 扩展对话框：renderer 应答（requestId 含 sessionId 全局唯一；host 遍历幂等） */
	ExtensionDialogRespond: "extension-dialog:respond",
	/** 权限门控配置（enabled 解析保留，UI 无入口；chip 逃生舱禁用态感知用） */
	PermissionGetConfig: "permission:getConfig",
	/** 会话权限模式（default / fullAccess；内存态，不落盘） */
	PermissionGetMode: "permission:getMode",
	PermissionSetMode: "permission:setMode",
	/** 上下文管理模式二态（设置 UI「通用」面板，默认蒸发） */
	ContextManagerGetConfig: "contextManager:getConfig",
	ContextManagerSetMode: "contextManager:setMode",
	/** channel-watch 跨会话频道唤醒开关（设置 UI「通用」面板） */
	ChannelWatchGetConfig: "channelWatch:getConfig",
	ChannelWatchSetEnabled: "channelWatch:setEnabled",
	/** 项目信任应答（选项下标） */
	TrustRespond: "trust:respond",
	ProjectPickDirectory: "project:pickDirectory",
	ProjectGetGitBranch: "project:getGitBranch",
	ProjectListGitBranches: "project:listGitBranches",
	ProjectCheckoutBranch: "project:checkoutBranch",
	AppOpenExternal: "app:openExternal",
	/** 应用信息（版本/运行时版本/仓库地址，设置关于页用） */
	AppGetInfo: "app:getInfo",
	/** 日常空间工作台目录（~/.percho/daily；懒创建后返回，日常会话的固定 cwd） */
	AppGetDailyDir: "app:getDailyDir",
	/** 顶栏 tabs 持久化（userData/tabs.json，不依赖 renderer localStorage） */
	TabsLoad: "tabs:load",
	TabsSave: "tabs:save",
	/** 应用 UI 状态持久化（userData/ui-state.json：上次使用的模型/思考级别 + 主题/背景） */
	UiStateLoad: "uiState:load",
	UiStateSave: "uiState:save",
	/** 自定义背景：弹图选框并拷贝进 userData/backgrounds/，返回文件名（取消返回 null） */
	BackgroundPick: "background:pick",
	/** 检查更新（纯检查：发现新版只提示不下载） */
	UpdateCheck: "update:check",
	/** 下载更新（已发现新版→下载；未发现→先检查）；仅用户显式点击触发 */
	UpdateDownload: "update:download",
	/** 重启并安装已下载的更新 */
	UpdateInstall: "update:install",
	UiPluginsGetConfig: "uiPlugins:getConfig",
	/** UI 插件：设全局总开关 */
	UiPluginsSetEnabled: "uiPlugins:setEnabled",
	/** UI 插件：列插件（含状态） */
	UiPluginsList: "uiPlugins:list",
	/** UI 插件：读构建产物代码 */
	UiPluginsReadCode: "uiPlugins:readCode",
	/** UI 插件：启用/停用单个插件（启用=信任） */
	UiPluginsSetPluginEnabled: "uiPlugins:setPluginEnabled",
	/** UI 插件：槽位指派（pluginName=null 取消指派） */
	UiPluginsAssignSlot: "uiPlugins:assignSlot",
	/** UI 插件：重新构建 */
	UiPluginsRebuild: "uiPlugins:rebuild",
	/** UI 插件：打开插件目录（shell.openPath） */
	UiPluginsOpenDir: "uiPlugins:openDir",
} as const;

/**
 * 全通道字符串常量：事件通道 + 表化 invoke（camelCase key = PiApi 方法名）+ 迁移期遗留。
 * 迁移完成后 LEGACY_INVOKE_CHANNELS 段删除。
 */
export const IpcChannels = Object.freeze({
	...EVENT_CHANNELS,
	...channelsFromTable(CHANNEL_TABLE),
	...LEGACY_INVOKE_CHANNELS,
});
