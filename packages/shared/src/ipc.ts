import type {
	CreateSessionOptions,
	PermissionAnswer,
	PermissionRequest,
	SessionEventEnvelope,
	SessionMeta,
	SessionStats,
} from "./session";
import type { CustomProviderInput, ProviderInfo, ProviderTestResult } from "./settings";

/** IPC 通道名常量 */
export const IpcChannels = {
	SessionCreate: "session:create",
	SessionList: "session:list",
	SessionOpen: "session:open",
	SessionClose: "session:close",
	SessionPrompt: "session:prompt",
	SessionAbort: "session:abort",
	SessionSetModel: "session:setModel",
	SessionSetThinkingLevel: "session:setThinkingLevel",
	SessionCompact: "session:compact",
	SessionStats: "session:stats",
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
	/** main → renderer 事件 */
	Event: "pi:event",
	PermissionRequest: "pi:permission-request",
} as const;

/** 渲染进程经 preload 暴露的 window.pi 类型 */
export interface PiApi {
	createSession(options: CreateSessionOptions): Promise<SessionMeta>;
	listSessions(cwd?: string): Promise<SessionMeta[]>;
	openSession(filePath: string): Promise<SessionMeta>;
	closeSession(sessionId: string): Promise<void>;
	prompt(sessionId: string, text: string): Promise<void>;
	abort(sessionId: string): Promise<void>;
	setModel(sessionId: string, provider: string, modelId: string): Promise<void>;
	setThinkingLevel(sessionId: string, level: string): Promise<void>;
	compact(sessionId: string): Promise<void>;
	getStats(sessionId: string): Promise<SessionStats>;
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
	/** 订阅会话事件；返回取消函数 */
	onEvent(cb: (payload: SessionEventEnvelope) => void): () => void;
	onPermissionRequest(cb: (req: PermissionRequest) => void): () => void;
}
