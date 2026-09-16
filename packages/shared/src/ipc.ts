import type {
	ExtensionDialogRequest,
	ExtensionDialogResolved,
	ExtensionDialogRespond,
	ExtensionEditorTextEvent,
	ExtensionNotifyEvent,
} from "./extension-dialog";
import type { LanStatus } from "./lan";
import type { CatalogPackageType, CatalogSearchResult, ConfiguredPackageInfo } from "./packages";
import type {
	AppInfo,
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
	PermissionRequest,
	PermissionResolved,
	QueuedMessages,
	QuotaInfo,
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
} from "./settings";
import type { TodoItem } from "./todo";
import type { UiPluginInfo, UiPluginManifest, UiPluginsConfig, UiPluginsEventPayload } from "./ui-plugins";
import type { UpdateState } from "./update";
import { CHANNEL_TABLE, type InvokeApi } from "./ipc-channels";

export {
	type AnyChannelDef,
	CHANNEL_TABLE,
	ch,
	type ChannelCtor,
	type ChannelDef,
	IpcChannels,
	type InvokeApi,
	type InvokeHandlers,
	PACKAGES_CHANNELS,
	SESSION_CHANNELS,
} from "./ipc-channels";


/**
 * 渲染进程经 preload 暴露的 window.pi 类型。
 * invoke 成员：表化通道由 InvokeApi<CHANNEL_TABLE> 推导（shared/ipc-channels.ts 单一事实源，
 * key = 方法名）；表外成员（订阅 on*、platform）与迁移期遗留 invoke 在下方手写。
 */
export interface PiApi extends InvokeApi<typeof CHANNEL_TABLE> {
	/** 运行平台（preload 同步注入，供 renderer 按平台分流 UI：如顶栏红绿灯/窗口按钮留白） */
	readonly platform: "darwin" | "win32" | "linux" | (string & {});
	/** 跨全部项目目录枚举历史会话（项目管理页用） */
	listAllSessions(): Promise<SessionMeta[]>;
	openSession(filePath: string): Promise<SessionMeta>;
	closeSession(sessionId: string): Promise<void>;
	/** 删除会话（含磁盘 jsonl 文件，不可恢复） */
	deleteSession(sessionId: string, sessionFile?: string): Promise<void>;
	/** 发送消息；images 为随消息附带的图片（base64） */
	prompt(sessionId: string, text: string, images?: ImageInput[]): Promise<void>;
	abort(sessionId: string): Promise<void>;
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
	/** 无会话列出斜杠命令（draft 新会话用；信任未决的项目不弹窗，只含用户级资源） */
	listSlashCommandsForCwd(cwd: string): Promise<SlashCommandInfo[]>;
	/** 设置会话显示名（触发 session_info_changed 事件） */
	setSessionName(sessionId: string, name: string): Promise<void>;
	/** 导出会话内容（HTML/JSONL），返回文件内容文本 */
	exportSession(sessionId: string, format: "html" | "jsonl"): Promise<string>;
	/**
	 * 在指定 assistant 消息处分叉：生成以其为结尾的新会话并切换过去（原会话文件保留）。
	 * ref.entryId 精确定位（历史消息）；缺省时按 ref.text 从分支尾部匹配最近一条同文 assistant 消息。
	 * 运行或压缩中的会话拒绝 fork。返回新会话 meta。
	 */
	forkSession(sessionId: string, ref: { entryId?: string; text?: string }): Promise<SessionMeta>;
	/**
	 * 撤回一条用户消息：会话回退到该消息发送之前（被撤回内容在文件中保留为侧枝），
	 * 文本与图片返回给调用方放回输入框。运行或压缩中的会话拒绝撤回。
	 */
	recallMessage(
		sessionId: string,
		ref: { entryId?: string; text?: string; timestamp?: number },
	): Promise<{ text: string; images: ImageInput[] }>;
	/** 读取会话已加载的资源（skills/扩展；设置页展示用） */
	getLoadedResources(sessionId: string): Promise<LoadedResources>;
	/** 安装社区包（npm:<name>，用户级）；成功后热重载非流式活跃会话 */
	installPackage(name: string): Promise<void>;
	/** 卸载已配置的包（按 source + scope 移除并持久化）；成功后热重载非流式活跃会话 */
	removePackage(source: string, scope: "user" | "project"): Promise<void>;
	/** 列出 settings.json 已配置的包（「已安装」态匹配用） */
	listConfiguredPackages(): Promise<ConfiguredPackageInfo[]>;
	/** 弹保存对话框并写文件；用户取消返回 null，成功返回写入路径 */
	saveFileDialog(defaultName: string, content: string): Promise<string | null>;
	listModels(): Promise<import("./session").AvailableModel[]>;
	/** 列出 provider（默认只走内置目录+本地缓存；forceNetwork 时联网拉最新模型目录） */
	listProviders(options?: ListProvidersOptions): Promise<ProviderInfo[]>;
	saveApiKey(providerId: string, key: string): Promise<void>;
	removeCredential(providerId: string): Promise<void>;
	addCustomProvider(input: CustomProviderInput): Promise<void>;
	/** 更新自定义 provider（ID 不可改；apiKey 留空保持不变） */
	updateCustomProvider(input: CustomProviderUpdateInput): Promise<void>;
	removeCustomProvider(providerId: string): Promise<void>;
	/** 内置 provider 的可选 baseUrl 覆写（pi 官方语义：不写 models，共享官方模型列表）；baseUrl 空串 = 清除覆写回官方 */
	setProviderBaseUrl(providerId: string, baseUrl: string, apiKey?: string): Promise<void>;
	testProvider(providerId: string, modelId?: string): Promise<ProviderTestResult>;
	/** 读取用户级模型可见性与子代理模型偏好 */
	getModelPrefs(): Promise<ModelPrefs>;
	/** 设置模型在选择器中的可见性；隐藏不影响已经选中的会话运行 */
	setModelHidden(provider: string, modelId: string, hidden: boolean): Promise<ModelPrefs>;
	/** 批量设置一组模型可见性（一键全隐藏/全显示某 provider 的全部模型）；一次写盘 */
	setModelsHidden(provider: string, modelIds: string[], hidden: boolean): Promise<ModelPrefs>;
	/** 为子代理指定 provider/model；null = 继承父会话模型 */
	setSubagentModel(agent: string, modelRef: string | null): Promise<ModelPrefs>;
	/** 为子代理指定思考深度；null = 跟随 agent 定义（无定义时走 SDK 默认链） */
	setSubagentThinking(agent: string, level: string | null): Promise<ModelPrefs>;
	/** 内置 subagent 执行器优先；新会话/恢复会话生效（不开会话不受后续变化影响） */
	setSubagentPreferBuiltin(enabled: boolean): Promise<ModelPrefs>;
	/** 列内置与用户级 subagent 定义（不读项目级定义） */
	listSubagents(): Promise<SubagentInfo[]>;
	/** 启动 provider 交互登录（OAuth 浏览器/设备码流 · api_key 提示/选择流）；事件经 onProviderLoginEvent 推送，promise 在流程结束时 resolve（取消不算错误） */
	startProviderLogin(loginId: string, providerId: string): Promise<LoginResult>;
	/** 取消进行中的登录流程（未知 loginId 静默忽略） */
	cancelProviderLogin(loginId: string): Promise<void>;
	/** 应答登录过程中的输入/选择提示（promptId 已被外部取消时静默忽略） */
	respondProviderLogin(loginId: string, promptId: string, value: string): Promise<void>;
	/** 订阅登录流程事件（event/prompt/prompt-cancel，按 loginId 归属）；返回取消函数 */
	onProviderLoginEvent(cb: (payload: LoginEventPayload) => void): () => void;
	/** 读取局域网观察服务状态（URL/二维码只在启用并监听后提供）。 */
	lanGetStatus(): Promise<LanStatus>;
	/** 启用或停止局域网只读观察服务；启用时轮换访问 token。 */
	lanSetEnabled(enabled: boolean): Promise<LanStatus>;
	/** 设置远程控制开关（独立于观察开关；未开观察时允许配置但不生效）。 */
	lanSetRemoteControl(enabled: boolean): Promise<LanStatus>;
	respondPermission(requestId: string, answer: PermissionAnswer): Promise<void>;
	/** 读取权限门控配置（enabled=false = 手改 permissions.json 的隐藏逃生舱态，chip 禁用提示用） */
	getPermissionConfig(): Promise<PermissionConfigInfo>;
	/** 读取会话权限模式（default 缺省；关 tab 重开后端已归零，renderer 对齐真值用） */
	getPermissionMode(sessionId: string): Promise<PermissionMode>;
	/** 设置会话权限模式（内存态即时生效、不落盘、重启归零） */
	setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>;
	/** 读取上下文管理模式（evaporation / off 二态派生） */
	getContextManagerConfig(): Promise<ContextManagerConfigInfo>;
	/** 设置上下文管理模式（写后 ≤2s 生效，无需重开会话） */
	setContextManagerMode(mode: ContextManagerMode): Promise<void>;
	/** 读取 channel-watch 频道唤醒开关状态 */
	getChannelWatchConfig(): Promise<ChannelWatchConfigInfo>;
	/** 设置 channel-watch 开关（下一 session_start 生效：目录 init/watcher/工具注册全部跟随） */
	setChannelWatchEnabled(enabled: boolean): Promise<void>;
	/** 应答项目信任请求（optionIndex 为 TrustRequest.options 下标） */
	respondTrust(requestId: string, answer: TrustAnswer): Promise<void>;
	/** 项目信任前置决策（选目录/切 draft cwd 时调用；未决弹窗，结果落 trust.json） */
	ensureProjectTrust(cwd: string): Promise<boolean>;
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
	/** 日常空间工作台目录（不存在则懒创建；日常会话的固定 cwd，信任链无资源自动信任） */
	getDailyDir(): Promise<string>;
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
	/** 检查更新（纯检查不下载，状态经 onUpdateEvent 推送） */
	checkForUpdates(): Promise<void>;
	/** 下载更新（已发现新版→下载；未发现→先检查） */
	downloadUpdate(): Promise<void>;
	/** 重启并安装已下载的更新 */
	installUpdate(): Promise<void>;
	/** 订阅更新状态（checking/available/downloading/downloaded/error）；返回取消函数 */
	onUpdateEvent(cb: (state: UpdateState) => void): () => void;
	/** 读 UI 插件全局配置（总开关/启用信任表/槽位指派） */
	uiPluginsGetConfig(): Promise<UiPluginsConfig>;
	/** 设 UI 插件全局总开关 */
	uiPluginsSetEnabled(enabled: boolean): Promise<void>;
	/** 列 UI 插件（含 enabled/trusted/buildError/invalidReason） */
	uiPluginsList(): Promise<UiPluginInfo[]>;
	/** 读插件构建产物（name 必须是扫描到的合法插件名，禁路径）；{ manifest, code } 或 { error } */
	uiPluginsReadCode(name: string): Promise<{ manifest: UiPluginManifest; code: string } | { error: string }>;
	/** 启用/停用单个插件（启用=信任，同步落盘） */
	uiPluginsSetPluginEnabled(name: string, enabled: boolean): Promise<void>;
	/** 槽位指派（pluginName=null 取消指派） */
	uiPluginsAssignSlot(slot: string, pluginName: string | null): Promise<void>;
	/** 重新构建插件（构建失败返回错误信息，旧产物保留） */
	uiPluginsRebuild(name: string): Promise<{ ok: true } | { ok: false; error: string }>;
	/** 打开插件目录（不传 name 开根目录；shell.openPath） */
	uiPluginsOpenDir(name?: string): Promise<void>;
	/** 订阅 UI 插件事件（changed/config）；返回取消函数 */
	onUiPluginsEvent(cb: (payload: UiPluginsEventPayload) => void): () => void;
	/** 订阅会话事件；返回取消函数 */
	onEvent(cb: (payload: SessionEventEnvelope) => void): () => void;
	onPermissionRequest(cb: (req: PermissionRequest) => void): () => void;
	onPermissionResolved(cb: (result: PermissionResolved) => void): () => void;
	/** 订阅项目信任请求；返回取消函数 */
	onTrustRequest(cb: (req: TrustRequest) => void): () => void;
	/** 订阅扩展对话框请求（renderer 停靠槽数据源）；返回取消函数 */
	onExtensionDialogRequest(cb: (req: ExtensionDialogRequest) => void): () => void;
	/** 订阅扩展对话框结算（应答/超时/中止/会话关闭都会广播，撤卡）；返回取消函数 */
	onExtensionDialogResolved(cb: (result: ExtensionDialogResolved) => void): () => void;
	/** 订阅扩展 notify（→ 全局 Toast）；返回取消函数 */
	onExtensionNotify(cb: (event: ExtensionNotifyEvent) => void): () => void;
	/** 订阅扩展草稿预填（setEditorText/pasteToEditor → Composer）；返回取消函数 */
	onExtensionEditorText(cb: (event: ExtensionEditorTextEvent) => void): () => void;
	/** 应答扩展对话框（宿主按 requestId 归属路由，未知 id 静默忽略） */
	respondExtensionDialog(requestId: string, answer: ExtensionDialogRespond): Promise<void>;
}
