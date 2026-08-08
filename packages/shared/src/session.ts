import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** 顶栏打开的会话持久化（重启恢复用，由主进程写入 userData/tabs.json） */
export interface SavedTabs {
	files: string[];
	activeFile: string | null;
}

/** 应用 UI 状态持久化（重启恢复用，主进程写 userData/ui-state.json）：新会话复用上次的模型/思考级别 */
export interface UiState {
	currentModel: { provider: string; modelId: string } | null;
	thinkingLevel: string;
}

/** 会话元数据（IPC 往返用，独立于 pi 内部类型） */
export interface SessionMeta {
	sessionId: string;
	/** 会话文件路径（持久化会话）；内存会话为 undefined */
	sessionFile?: string;
	cwd: string;
	/** 会话标题（用户设置或自动生成） */
	name?: string;
	modelLabel?: string;
	/** 是否仍在内存中活跃（否则是历史会话） */
	active: boolean;
	/** 消息条数（用于历史列表展示） */
	messageCount: number;
	/** 创建时间（unix 毫秒） */
	createdAt: number;
	/** 最后活动时间（unix 毫秒，历史会话列表排序/分组用） */
	modifiedAt?: number;
}

export interface SessionStats {
	/** 累计 token 用量 */
	inputTokens: number;
	outputTokens: number;
	/** 累计费用（美元） */
	cost: number;
}

/** 历史会话中的一次工具调用（渲染用） */
export interface SessionToolCall {
	id: string;
	name: string;
	/** 参数（JSON 字符串） */
	args: string;
	/** 执行输出 */
	output: string;
	isError: boolean;
}

/** 历史会话消息（打开历史会话时回放用；不依赖 pi 内部类型） */
export interface SessionMessage {
	role: "user" | "assistant";
	text: string;
	thinking: string;
	tools: SessionToolCall[];
	/** user 消息附带的图片 */
	images: ImageInput[];
	timestamp: number;
}

export interface AvailableModel {
	provider: string;
	/** provider 显示名（如 "Anthropic"） */
	providerName: string;
	id: string;
	/** 展示名，如 "Claude Opus 4.5" */
	label: string;
	/** 是否有可用凭证 */
	authed: boolean;
}

/** 随消息附带的图片（pi ImageContent；data 为纯 base64，不含 data URL 前缀） */
export interface ImageInput {
	data: string;
	mimeType: string;
}

/** 斜杠命令来源 */
export type SlashCommandSource = "builtin" | "template" | "skill" | "extension";

/** 斜杠命令条目（补全面板展示用） */
export interface SlashCommandInfo {
	/** 命令名，不含前导 / */
	name: string;
	description: string;
	argumentHint?: string;
	source: SlashCommandSource;
	/** 内置命令是否已在桌面端实现（模板/skill/扩展命令恒为 true，SDK 原生处理） */
	supported: boolean;
}

/** 当前模型上下文使用情况（圆环进度条用；percent/tokens 为 null 表示未知，如刚压缩后） */
export interface ContextUsageInfo {
	/** 估计的已用上下文 tokens */
	tokens: number | null;
	/** 模型最大上下文窗口 */
	contextWindow: number;
	/** 已用百分比（0-100），未知为 null */
	percent: number | null;
}

/** 运行中排队的消息（clearQueue 返回结构；桌面端只用 followUp，steering 恒为空） */
export interface QueuedMessages {
	steering: string[];
	followUp: string[];
}

export interface CreateSessionOptions {
	cwd: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
}

/** 权限确认请求（由 backend 的 uiContext.confirm 桥接产生） */
export interface PermissionRequest {
	id: string;
	sessionId: string;
	title: string;
	message: string;
}

export type PermissionAnswer = "allow" | "deny" | "allowAlways";

/**
 * 项目信任选项（创建/打开会话时，项目含 .pi/ 资源或祖先 .agents/skills 需用户决策）。
 * key 由 backend 分类，renderer 按 key 出 i18n 文案；parentPath 仅 trustParent 有值。
 */
export interface TrustOption {
	key: "trust" | "trustParent" | "trustSession" | "deny" | "denySession";
	parentPath?: string;
}

/** 项目信任请求（发生在会话创建前，无 sessionId） */
export interface TrustRequest {
	id: string;
	cwd: string;
	options: TrustOption[];
}

/** 信任应答：所选选项在 TrustRequest.options 中的下标 */
export type TrustAnswer = number;

/** git 分支信息（项目管理页/空态分支选择器用） */
export interface GitBranches {
	current: string | null;
	branches: string[];
}

/** 渲染进程收到的统一事件包络 */
export interface SessionEventEnvelope {
	sessionId: string;
	event: AgentSessionEvent;
}

/**
 * pi 会话事件类型（type-only 转发自 pi SDK，运行时零依赖）。
 * 保证 backend / preload / renderer 三方对事件流有完全一致的强类型。
 */
export type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
