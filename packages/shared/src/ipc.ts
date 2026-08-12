import type { CatalogPackageType, CatalogSearchResult, ConfiguredPackageInfo } from "./packages";
import type {
	AppInfo,
	ContextUsageInfo,
	CreateSessionOptions,
	GitBranches,
	ImageInput,
	LoadedResources,
	PermissionAnswer,
	PermissionConfigInfo,
	PermissionRequest,
	QueuedMessages,
	SavedTabs,
	SessionEventEnvelope,
	SessionMessage,
	SessionMeta,
	SessionStats,
	SlashCommandInfo,
	TrustAnswer,
	TrustRequest,
	UiState,
} from "./session";
import type { CustomProviderInput, ProviderInfo, ProviderTestResult } from "./settings";
import type { TodoItem } from "./todo";
import type { UpdateState } from "./update";

/** IPC 通道名常量 */
export const IpcChannels = {
	SessionCreate: "session:create",
	SessionList: "session:list",
	SessionListAll: "session:listAll",
	SessionOpen: "session:open",
	SessionClose: "session:close",
	SessionDelete: "session:delete",
	SessionPrompt: "session:prompt",
	SessionAbort: "session:abort",
	SessionSetModel: "session:setModel",
	SessionSetThinkingLevel: "session:setThinkingLevel",
	SessionGetMessages: "session:getMessages",
	SessionGetTodos: "session:getTodos",
	SessionCompact: "session:compact",
	SessionStats: "session:stats",
	SessionGetContextUsage: "session:getContextUsage",
	SessionClearQueue: "session:clearQueue",
	SessionGetFollowUpMessages: "session:getFollowUpMessages",
	SessionListSlashCommands: "session:listSlashCommands",
	SessionSetName: "session:setName",
	SessionExport: "session:export",
	SessionFork: "session:fork",
	/** 已加载资源（skills/扩展，设置页展示用） */
	SessionGetLoadedResources: "session:getLoadedResources",
	/** pi.dev 社区包目录（设置页扩展面板浏览/安装用） */
	PackagesSearchCatalog: "packages:searchCatalog",
	PackagesInstall: "packages:install",
	PackagesRemove: "packages:remove",
	PackagesListConfigured: "packages:listConfigured",
	FileSaveDialog: "file:saveDialog",
	ModelsList: "models:list",
	SettingsListProviders: "settings:listProviders",
	SettingsSaveApiKey: "settings:saveApiKey",
	SettingsRemoveCredential: "settings:removeCredential",
	SettingsAddCustomProvider: "settings:addCustomProvider",
	SettingsRemoveCustomProvider: "settings:removeCustomProvider",
	SettingsTestProvider: "settings:testProvider",
	PermissionRespond: "permission:respond",
	/** 权限门控配置（设置 UI 开关） */
	PermissionGetConfig: "permission:getConfig",
	PermissionSetEnabled: "permission:setEnabled",
	/** 项目信任应答（选项下标） */
	TrustRespond: "trust:respond",
	ProjectPickDirectory: "project:pickDirectory",
	ProjectGetGitBranch: "project:getGitBranch",
	ProjectListGitBranches: "project:listGitBranches",
	ProjectCheckoutBranch: "project:checkoutBranch",
	/** @ 补全数据源：项目文件相对路径列表（目录带尾 /） */
	ProjectListFiles: "project:listFiles",
	AppOpenExternal: "app:openExternal",
	/** 应用信息（版本/运行时版本/仓库地址，设置关于页用） */
	AppGetInfo: "app:getInfo",
	/** 顶栏 tabs 持久化（userData/tabs.json，不依赖 renderer localStorage） */
	TabsLoad: "tabs:load",
	TabsSave: "tabs:save",
	/** 应用 UI 状态持久化（userData/ui-state.json：上次使用的模型/思考级别 + 主题/背景） */
	UiStateLoad: "uiState:load",
	UiStateSave: "uiState:save",
	/** 自定义背景：弹图选框并拷贝进 userData/backgrounds/，返回文件名（取消返回 null） */
	BackgroundPick: "background:pick",
	/** 检查更新（silent=true 静默：无更新不打扰） */
	UpdateCheck: "update:check",
	/** 重启并安装已下载的更新 */
	UpdateInstall: "update:install",
	/** main → renderer 更新状态 */
	UpdateEvent: "update:event",
	/** main → renderer 事件 */
	Event: "pi:event",
	PermissionRequest: "pi:permission-request",
	/** main → renderer 项目信任请求（会话创建前） */
	TrustRequest: "pi:trust-request",
} as const;

/** 渲染进程经 preload 暴露的 window.pi 类型 */
export interface PiApi {
	createSession(options: CreateSessionOptions): Promise<SessionMeta>;
	listSessions(cwd?: string): Promise<SessionMeta[]>;
	/** 跨全部项目目录枚举历史会话（项目管理页用） */
	listAllSessions(): Promise<SessionMeta[]>;
	openSession(filePath: string): Promise<SessionMeta>;
	closeSession(sessionId: string): Promise<void>;
	/** 删除会话（含磁盘 jsonl 文件，不可恢复） */
	deleteSession(sessionId: string, sessionFile?: string): Promise<void>;
	/** 发送消息；images 为随消息附带的图片（base64） */
	prompt(sessionId: string, text: string, images?: ImageInput[]): Promise<void>;
	abort(sessionId: string): Promise<void>;
	setModel(sessionId: string, provider: string, modelId: string): Promise<void>;
	setThinkingLevel(sessionId: string, level: string): Promise<void>;
	/** 读取会话历史消息（打开历史会话时回放） */
	getSessionMessages(sessionId: string): Promise<SessionMessage[]>;
	/** 读取会话当前 todo 列表（最后一条 todo 工具结果，或 compaction 后恢复的 reminder 消息；无则空数组） */
	getTodos(sessionId: string): Promise<TodoItem[]>;
	compact(sessionId: string, customInstructions?: string): Promise<void>;
	getStats(sessionId: string): Promise<SessionStats>;
	/** 当前模型上下文使用（tokens/contextWindow/percent），无会话或未知时返回 null */
	getContextUsage(sessionId: string): Promise<ContextUsageInfo | null>;
	/** 清空运行中排队的消息（steer+followUp 都清），返回被清内容（abort 时还原草稿/队列面板清空按钮用） */
	clearQueue(sessionId: string): Promise<QueuedMessages>;
	/** 当前排队的 followUp 消息文本（切换会话回来自恢复队列面板用） */
	getFollowUpMessages(sessionId: string): Promise<string[]>;
	/** 列出斜杠命令（内置 + prompt 模板 + skill + 扩展命令） */
	listSlashCommands(sessionId: string): Promise<SlashCommandInfo[]>;
	/** 设置会话显示名（触发 session_info_changed 事件） */
	setSessionName(sessionId: string, name: string): Promise<void>;
	/** 导出会话内容（HTML/JSONL），返回文件内容文本 */
	exportSession(sessionId: string, format: "html" | "jsonl"): Promise<string>;
	/**
	 * 在指定 assistant 消息处分叉：生成以其为结尾的新会话并切换过去（原会话文件保留）。
	 * ref.entryId 精确定位（历史消息）；缺省时按 ref.text 从分支尾部匹配最近一条同文 assistant 消息。
	 * 运行中的会话拒绝 fork。返回新会话 meta。
	 */
	forkSession(sessionId: string, ref: { entryId?: string; text?: string }): Promise<SessionMeta>;
	/** 读取会话已加载的资源（skills/扩展；设置页展示用） */
	getLoadedResources(sessionId: string): Promise<LoadedResources>;
	/** 搜索 pi.dev 社区包目录（服务端模糊匹配名称/描述/作者，50 条/页） */
	searchCatalog(query: string, type?: CatalogPackageType | "", page?: number): Promise<CatalogSearchResult>;
	/** 安装社区包（npm:<name>，用户级）；成功后热重载非流式活跃会话 */
	installPackage(name: string): Promise<void>;
	/** 卸载已配置的包（按 source + scope 移除并持久化）；成功后热重载非流式活跃会话 */
	removePackage(source: string, scope: "user" | "project"): Promise<void>;
	/** 列出 settings.json 已配置的包（「已安装」态匹配用） */
	listConfiguredPackages(): Promise<ConfiguredPackageInfo[]>;
	/** 弹保存对话框并写文件；用户取消返回 null，成功返回写入路径 */
	saveFileDialog(defaultName: string, content: string): Promise<string | null>;
	listModels(): Promise<import("./session").AvailableModel[]>;
	listProviders(): Promise<ProviderInfo[]>;
	saveApiKey(providerId: string, key: string): Promise<void>;
	removeCredential(providerId: string): Promise<void>;
	addCustomProvider(input: CustomProviderInput): Promise<void>;
	removeCustomProvider(providerId: string): Promise<void>;
	testProvider(providerId: string, modelId?: string): Promise<ProviderTestResult>;
	respondPermission(requestId: string, answer: PermissionAnswer): Promise<void>;
	/** 读取权限门控开关状态 */
	getPermissionConfig(): Promise<PermissionConfigInfo>;
	/** 设置权限门控开关（即时生效，扩展按 mtime 重读配置） */
	setPermissionEnabled(enabled: boolean): Promise<void>;
	/** 应答项目信任请求（optionIndex 为 TrustRequest.options 下标） */
	respondTrust(requestId: string, answer: TrustAnswer): Promise<void>;
	pickDirectory(): Promise<string | null>;
	/** @ 补全数据源：项目文件相对路径列表（目录带尾 /，TTL 缓存） */
	listProjectFiles(cwd?: string): Promise<string[]>;
	getGitBranch(cwd: string): Promise<string | null>;
	listGitBranches(cwd: string): Promise<GitBranches>;
	/** 切换分支；返回切换后的当前分支（失败抛错） */
	checkoutBranch(cwd: string, branch: string): Promise<string>;
	/** 用系统浏览器打开链接 */
	openExternal(url: string): Promise<void>;
	/** 读取应用信息（版本/运行时/仓库地址） */
	getAppInfo(): Promise<AppInfo>;
	/** 读取持久化的顶栏 tabs（无数据返回 null） */
	loadTabs(): Promise<SavedTabs | null>;
	/** 持久化顶栏 tabs（主进程写 userData/tabs.json） */
	saveTabs(tabs: SavedTabs): Promise<void>;
	/** 读取持久化 UI 状态（上次使用的模型/思考级别/主题/背景；无数据返回 null） */
	loadUiState(): Promise<UiState | null>;
	/** 持久化 UI 状态（主进程合并写入 userData/ui-state.json，传补丁即可） */
	saveUiState(state: Partial<UiState>): Promise<void>;
	/** 弹图选框选背景图并拷贝进 userData/backgrounds/；返回文件名（经 pi-bg://background/<name> 加载），取消返回 null */
	pickBackgroundImage(): Promise<string | null>;
	/** 检查更新（发现新版自动开始后台下载，状态经 onUpdateEvent 推送） */
	checkForUpdates(): Promise<void>;
	/** 重启并安装已下载的更新 */
	installUpdate(): Promise<void>;
	/** 订阅更新状态（checking/available/downloading/downloaded/error）；返回取消函数 */
	onUpdateEvent(cb: (state: UpdateState) => void): () => void;
	/** 订阅会话事件；返回取消函数 */
	onEvent(cb: (payload: SessionEventEnvelope) => void): () => void;
	onPermissionRequest(cb: (req: PermissionRequest) => void): () => void;
	/** 订阅项目信任请求；返回取消函数 */
	onTrustRequest(cb: (req: TrustRequest) => void): () => void;
}
