import type {
	ExtensionDialogRequest,
	ExtensionDialogResolved,
	ExtensionDialogRespond,
	ExtensionEditorTextEvent,
	ExtensionNotifyEvent,
} from "./extension-dialog";
import type { CHANNEL_TABLE, InvokeApi } from "./ipc-channels";
import type { LanStatus } from "./lan";
import type { ConfiguredPackageInfo } from "./packages";
import type {
	AppInfo,
	GitBranches,
	PermissionRequest,
	PermissionResolved,
	SavedTabs,
	SessionEventEnvelope,
	TrustRequest,
	UiState,
} from "./session";
import type { LoginEventPayload } from "./settings";
import type { UiPluginInfo, UiPluginManifest, UiPluginsConfig, UiPluginsEventPayload } from "./ui-plugins";
import type { UpdateState } from "./update";

export {
	type AnyChannelDef,
	APP_CHANNELS,
	CHANNEL_TABLE,
	type ChannelCtor,
	type ChannelDef,
	ch,
	type InvokeApi,
	type InvokeHandlers,
	IpcChannels,
	PACKAGES_CHANNELS,
	SESSION_CHANNELS,
	SETTINGS_CHANNELS,
} from "./ipc-channels";

/**
 * 渲染进程经 preload 暴露的 window.pi 类型。
 * invoke 成员：表化通道由 InvokeApi<CHANNEL_TABLE> 推导（shared/ipc-channels.ts 单一事实源，
 * key = 方法名）；表外成员（订阅 on*、platform）与迁移期遗留 invoke 在下方手写。
 */
export interface PiApi extends InvokeApi<typeof CHANNEL_TABLE> {
	/** 运行平台（preload 同步注入，供 renderer 按平台分流 UI：如顶栏红绿灯/窗口按钮留白） */
	readonly platform: "darwin" | "win32" | "linux" | (string & {});
	/** 安装社区包（npm:<name>，用户级）；成功后热重载非流式活跃会话 */
	installPackage(name: string): Promise<void>;
	/** 卸载已配置的包（按 source + scope 移除并持久化）；成功后热重载非流式活跃会话 */
	removePackage(source: string, scope: "user" | "project"): Promise<void>;
	/** 列出 settings.json 已配置的包（「已安装」态匹配用） */
	listConfiguredPackages(): Promise<ConfiguredPackageInfo[]>;
	/** 订阅登录流程事件（event/prompt/prompt-cancel，按 loginId 归属）；返回取消函数 */
	onProviderLoginEvent(cb: (payload: LoginEventPayload) => void): () => void;
	/** 读取局域网观察服务状态（URL/二维码只在启用并监听后提供）。 */
	lanGetStatus(): Promise<LanStatus>;
	/** 启用或停止局域网只读观察服务；启用时轮换访问 token。 */
	lanSetEnabled(enabled: boolean): Promise<LanStatus>;
	/** 设置远程控制开关（独立于观察开关；未开观察时允许配置但不生效）。 */
	lanSetRemoteControl(enabled: boolean): Promise<LanStatus>;
	pickDirectory(): Promise<string | null>;
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
