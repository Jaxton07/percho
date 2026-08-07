import type {
	ContextUsageInfo,
	CreateSessionOptions,
	GitBranches,
	ImageInput,
	PermissionAnswer,
	PermissionRequest,
	SessionEventEnvelope,
	SessionMessage,
	SessionMeta,
	SessionStats,
	SlashCommandInfo,
} from "./session";
import type { CustomProviderInput, ProviderInfo, ProviderTestResult } from "./settings";

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
	SessionCompact: "session:compact",
	SessionStats: "session:stats",
	SessionGetContextUsage: "session:getContextUsage",
	SessionListSlashCommands: "session:listSlashCommands",
	SessionSetName: "session:setName",
	SessionExport: "session:export",
	FileSaveDialog: "file:saveDialog",
	ModelsList: "models:list",
	SettingsListProviders: "settings:listProviders",
	SettingsSaveApiKey: "settings:saveApiKey",
	SettingsRemoveCredential: "settings:removeCredential",
	SettingsAddCustomProvider: "settings:addCustomProvider",
	SettingsRemoveCustomProvider: "settings:removeCustomProvider",
	SettingsTestProvider: "settings:testProvider",
	PermissionRespond: "permission:respond",
	ProjectPickDirectory: "project:pickDirectory",
	ProjectGetGitBranch: "project:getGitBranch",
	ProjectListGitBranches: "project:listGitBranches",
	ProjectCheckoutBranch: "project:checkoutBranch",
	AppOpenExternal: "app:openExternal",
	/** main → renderer 事件 */
	Event: "pi:event",
	PermissionRequest: "pi:permission-request",
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
	compact(sessionId: string): Promise<void>;
	getStats(sessionId: string): Promise<SessionStats>;
	/** 当前模型上下文使用（tokens/contextWindow/percent），无会话或未知时返回 null */
	getContextUsage(sessionId: string): Promise<ContextUsageInfo | null>;
	/** 列出斜杠命令（内置 + prompt 模板 + skill + 扩展命令） */
	listSlashCommands(sessionId: string): Promise<SlashCommandInfo[]>;
	/** 设置会话显示名（触发 session_info_changed 事件） */
	setSessionName(sessionId: string, name: string): Promise<void>;
	/** 导出会话内容（HTML/JSONL），返回文件内容文本 */
	exportSession(sessionId: string, format: "html" | "jsonl"): Promise<string>;
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
	pickDirectory(): Promise<string | null>;
	getGitBranch(cwd: string): Promise<string | null>;
	listGitBranches(cwd: string): Promise<GitBranches>;
	/** 切换分支；返回切换后的当前分支（失败抛错） */
	checkoutBranch(cwd: string, branch: string): Promise<string>;
	/** 用系统浏览器打开链接 */
	openExternal(url: string): Promise<void>;
	/** 订阅会话事件；返回取消函数 */
	onEvent(cb: (payload: SessionEventEnvelope) => void): () => void;
	onPermissionRequest(cb: (req: PermissionRequest) => void): () => void;
}
