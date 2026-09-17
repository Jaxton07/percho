import {
	emptyTranscript,
	type LanPendingPermission,
	type LanSessionView,
	messagesToUIMessages,
	reduceEvent,
	type SessionEvent,
	type SessionMessage,
	type SessionStats,
	type SessionTranscriptState,
	type TodoItem,
	type UIMessage,
} from "@percho/shared";

/** 视图尾部正文字符上限（assistantTail / 工具错误摘要截断）。 */
const TAIL_LIMIT = 2048;

/** 非 reducer 维度的视图底座（reducer 不维护的事实：标识/统计/墙钟/权限） */
export interface LanViewBase {
	name: string;
	cwd: string;
	stats: { inputTokens: number; outputTokens: number; cost: number } | null;
	lastActivity: number;
	pendingPermission: LanPendingPermission | null;
}

/** 会话投影：shared reducer 态（单一事实源，sanitize 事件流驱动）+ 非 reducer 底座。 */
export interface SessionProjection {
	state: SessionTranscriptState;
	base: LanViewBase;
}

/**
 * 种子投影：历史消息（sanitize 后）映射 UIMessage + backend 瞬时位（agentActive/compacting）。
 * in-flight 流式容器由种子后的 pendingEvents replay 重建（见 server.seedSession）。
 */
export function seedProjection(
	_sessionId: string,
	name: string,
	cwd: string,
	runtime: { streaming?: boolean; compacting?: boolean } | undefined,
	todos: TodoItem[],
	stats: SessionStats | null,
	messages: SessionMessage[],
	pending: LanPendingPermission | null,
): SessionProjection {
	return {
		state: {
			...emptyTranscript(),
			messages: messagesToUIMessages(messages),
			agentActive: runtime?.streaming ?? false,
			compacting: runtime?.compacting ?? false,
			todos,
		},
		base: {
			name,
			cwd,
			stats: stats
				? { inputTokens: stats.inputTokens, outputTokens: stats.outputTokens, cost: stats.cost }
				: null,
			lastActivity: Date.now(),
			pendingPermission: pending,
		},
	};
}

/** sanitize 后事件 → reducer（状态变化才刷新 lastActivity 并产生新投影引用）。 */
export function applyEvent(projection: SessionProjection, event: SessionEvent): SessionProjection {
	const state = reduceEvent(projection.state, event);
	if (state === projection.state) return projection;
	return { state, base: { ...projection.base, lastActivity: Date.now() } };
}

export function applyPermissionRequest(
	projection: SessionProjection,
	request: { title?: string; message?: string; kind?: string },
): SessionProjection {
	return {
		...projection,
		base: {
			...projection.base,
			pendingPermission: {
				title: request.title ?? "",
				message: request.message ?? "",
				kind: request.kind ?? "",
			},
		},
	};
}

export function applyPermissionResolved(projection: SessionProjection): SessionProjection {
	if (!projection.base.pendingPermission) return projection;
	return { ...projection, base: { ...projection.base, pendingPermission: null } };
}

/** 最近一个运行中的工具名（流式容器尾部倒序；无流式/全结束 → null）。 */
function currentToolOf(state: SessionTranscriptState): string | null {
	const tools = state.streaming?.tools;
	if (!tools) return null;
	for (let i = tools.length - 1; i >= 0; i--) {
		const tool = tools[i];
		if (tool?.state === "running") return tool.name;
	}
	return null;
}

/** 最新 assistant 正文尾部（流式中取流式容器，空闲取最后一条 assistant 消息）。 */
function assistantTailOf(state: SessionTranscriptState): string | null {
	const live = state.streaming?.text;
	if (live) return live.length > TAIL_LIMIT ? live.slice(-TAIL_LIMIT) : live;
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const message = state.messages[i];
		if (message?.kind === "assistant" && message.text) {
			return message.text.length > TAIL_LIMIT ? message.text.slice(-TAIL_LIMIT) : message.text;
		}
	}
	return null;
}

/** 最近错误（从 reducer 态派生：错误卡 → 压缩失败 → 工具错误；流式期工具优先）。 */
function lastErrorOf(state: SessionTranscriptState): string | null {
	const tool = state.streaming?.tools.find((t) => t.state === "error");
	if (tool?.output) return tool.output.slice(-TAIL_LIMIT);
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const message = state.messages[i];
		if (!message) continue;
		if (message.kind === "error" && message.error.detail) return message.error.detail;
		if (message.kind === "system" && message.compact?.status === "error") {
			return message.compact.errorMessage ?? "compaction failed";
		}
		const failed = message.kind === "assistant" ? message.tools.findLast((t) => t.state === "error") : null;
		if (failed?.output) return failed.output.slice(-TAIL_LIMIT);
	}
	return null;
}

/** 投影 → LAN 视图（六状态字段全部从 reducer 态派生，无第二状态机）。 */
export function deriveView(sessionId: string, projection: SessionProjection): LanSessionView {
	const { state, base } = projection;
	return {
		sessionId,
		name: base.name,
		cwd: base.cwd,
		agentActive: state.agentActive,
		compacting: state.compacting,
		queued: state.followUpQueue.length > 0,
		currentTool: currentToolOf(state),
		assistantTail: assistantTailOf(state),
		todos: state.todos,
		pendingPermission: base.pendingPermission,
		lastError: lastErrorOf(state),
		stats: base.stats,
		lastActivity: base.lastActivity,
	};
}

/** 快照出网净化：剥 UIMessage.sourceText（撤回/fork 匹配用的持久化原文，LAN 无此功能且属敏感面）。 */
export function sanitizeProjectionForWire(projection: SessionProjection, tailLimit: number) {
	const messages = projection.state.messages.slice(-tailLimit).map(stripMessage) as UIMessage[];
	return {
		...projection,
		state: { ...projection.state, messages },
		truncated: projection.state.messages.length > tailLimit,
	};
}

function stripMessage(message: UIMessage): UIMessage {
	if (message.kind === "user" || message.kind === "assistant") {
		if (message.sourceText === undefined) return message;
		const { sourceText: _sourceText, ...rest } = message;
		return rest as UIMessage;
	}
	return message;
}
