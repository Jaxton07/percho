import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentRunData } from "./subagent";

/** 顶栏打开的会话持久化（重启恢复用，由主进程写入 userData/tabs.json） */
export interface SavedTabs {
	files: string[];
	activeFile: string | null;
}

/** 主题模式：system = 跟随系统 prefers-color-scheme */
export type ThemeMode = "light" | "dark" | "system";

/** 自定义背景：image 为主进程 userData/backgrounds/ 下的文件名（renderer 经 pi-bg:// 协议加载）；dim 为遮罩不透明度 0–1（越大背景越淡） */
export interface BackgroundSettings {
	image: string | null;
	dim: number;
}

/** 应用 UI 状态持久化（重启恢复用，主进程写 userData/ui-state.json）：新会话复用上次的模型/思考级别；主题与背景设置 */
export interface UiState {
	currentModel: { provider: string; modelId: string } | null;
	thinkingLevel: string;
	theme: ThemeMode;
	background: BackgroundSettings;
	/** 左侧会话轨道开关（聊天页左侧短线悬停展开标题，见 SessionRail；旧版本文件缺省为 false） */
	sessionRailEnabled: boolean;
}

/** 会话元数据（IPC 往返用，独立于 pi 内部类型） */
/** 会话模型引用（provider + 模型 id） */
export interface SessionModelRef {
	provider: string;
	modelId: string;
}

export interface SessionMeta {
	sessionId: string;
	/** 会话文件路径（持久化会话）；内存会话为 undefined */
	sessionFile?: string;
	cwd: string;
	/** 会话标题（用户设置或自动生成） */
	name?: string;
	modelLabel?: string;
	/** 会话当前使用的模型（活跃会话才有值；未选择为 null） */
	model?: SessionModelRef | null;
	/** 会话当前思考级别（活跃会话才有值；未选择为 null） */
	thinkingLevel?: string | null;
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
export type SessionMessage =
	| {
			role: "user" | "assistant";
			text: string;
			thinking: string;
			tools: SessionToolCall[];
			/** user 消息附带的图片 */
			images: ImageInput[];
			timestamp: number;
			/** 会话树中的 entry id（assistant/user 消息均有；fork·撤回定位用，匹配失败时缺省） */
			entryId?: string;
	  }
	| {
			/** show_image 工具主动展示给用户的图片（独立消息，不进工具卡） */
			role: "image";
			images: ImageInput[];
			/** 原文件路径（工具参数，仅调试用） */
			paths: string[];
			timestamp: number;
	  }
	| {
			/** subagent 工具调用的结果（独立消息，不进工具卡折叠区） */
			role: "subagent";
			runs: SubagentRunData[];
			timestamp: number;
	  };

export interface AvailableModel {
	provider: string;
	/** provider 显示名（如 "Anthropic"） */
	providerName: string;
	id: string;
	/** 展示名，如 "Claude Opus 4.5" */
	label: string;
	/** 是否有可用凭证 */
	authed: boolean;
	/** 该模型支持的思考深度（off/minimal/low/medium/high/xhigh/max 子集）；未提供时 UI 按全量显示 */
	thinkingLevels?: string[];
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
/** 请求类别：path=路径类工具（可提供「允许此目录」建议根），command=命令类，other=其余 */
export type PermissionRequestKind = "path" | "command" | "other";

export interface PermissionRequest {
	id: string;
	sessionId: string;
	title: string;
	message: string;
	kind: PermissionRequestKind;
	/** path 类越界时建议加入工作区的根目录（git 根候选；无安全候选时缺省） */
	suggestDir?: string;
}

export type PermissionAnswer = "allow" | "deny" | "allowAlways" | "allowDir";

/** 权限门控配置（设置 UI 开关；规则全文在 ~/.pi/agent/permissions.json） */
export interface PermissionConfigInfo {
	enabled: boolean;
}

/**
 * 项目信任选项（添加项目/创建会话前，项目含 .pi/ 资源或祖先 .agents/skills 需用户决策）。
 * 刻意从 CLI 的五选项精简为两个（信任/不信任，均落盘）：「仅本次」在 draft 拉命令
 * + 建会话双检查点的流程里语义不明且场景极少。
 */
export interface TrustOption {
	key: "trust" | "deny";
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

/** 应用信息（设置 → 关于页展示，来自主进程） */
export interface AppInfo {
	/** 应用名 */
	name: string;
	/** 应用版本 */
	version: string;
	electron: string;
	chrome: string;
	node: string;
	platform: string;
	arch: string;
	/** 项目仓库地址（关于页/帮助跳转） */
	repoUrl: string;
}

/** 已加载资源的作用域（用户级 ~/.pi/agent / 项目级 / 临时合成） */
export type ResourceScope = "user" | "project" | "temporary";

/** 已加载的 skill（设置页 skills 面板数据源） */
export interface LoadedSkill {
	name: string;
	description: string;
	/** 来源作用域 */
	scope: ResourceScope;
	/** 来源标记（如用户级目录名 / 项目名） */
	source: string;
	/** SKILL.md 文件路径 */
	path: string;
	/** 是否禁用模型自动调用（仅手动触发） */
	disableModelInvocation: boolean;
}

/** 已加载的扩展（设置页 extensions 面板数据源） */
export interface LoadedExtension {
	/** 显示名（路径 basename；内置 inline 扩展用合成名） */
	name: string;
	/** 扩展路径（inline 扩展为合成路径） */
	path: string;
	scope: ResourceScope;
	/** 来源标记 */
	source: string;
	/** 隐藏扩展（如部分内部扩展） */
	hidden: boolean;
	/** 注册的工具数 */
	toolsCount: number;
	/** 注册的斜杠命令名 */
	commands: string[];
	/** 注册的 flag 数 */
	flagsCount: number;
	/** 注册的快捷键数 */
	shortcutsCount: number;
}

/** 资源加载诊断（collision 冲突/warning/error） */
export interface ResourceDiagnosticInfo {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
}

/** 会话已加载资源总览（设置页 skills/扩展面板数据，按会话项目加载） */
export interface LoadedResources {
	skills: LoadedSkill[];
	skillDiagnostics: ResourceDiagnosticInfo[];
	extensions: LoadedExtension[];
	extensionErrors: { path: string; error: string }[];
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
