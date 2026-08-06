import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

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
}

export interface SessionStats {
	/** 累计 token 用量 */
	inputTokens: number;
	outputTokens: number;
	/** 累计费用（美元） */
	cost: number;
}

export interface AvailableModel {
	provider: string;
	id: string;
	/** 展示名，如 "Claude Opus 4.5" */
	label: string;
	/** 是否有可用凭证 */
	authed: boolean;
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
