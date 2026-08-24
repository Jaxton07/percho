import {
	extractTodos,
	type LanSessionView,
	type PermissionRequest,
	type SessionEvent,
	type SessionMeta,
	type SessionStats,
	type TodoItem,
} from "@percho/shared";

const TAIL_LIMIT = 2048;

export interface LanSessionRuntime {
	streaming: boolean;
	compacting: boolean;
}

export interface LanPendingPermission {
	title: string;
	message: string;
	kind: string;
}

/** 由已有会话快照构建 LAN 投影初值。 */
export function seedView(
	meta: SessionMeta,
	runtime: LanSessionRuntime | undefined,
	todos: TodoItem[],
	stats: SessionStats | null,
	tail: string | null,
	pending: LanPendingPermission | null,
): LanSessionView {
	return {
		sessionId: meta.sessionId,
		name: meta.name?.trim() || "New session",
		cwd: meta.cwd,
		agentActive: runtime?.streaming ?? false,
		compacting: runtime?.compacting ?? false,
		queued: false,
		currentTool: null,
		assistantTail: trimTail(tail),
		todos,
		pendingPermission: pending,
		lastError: null,
		stats: stats
			? { inputTokens: stats.inputTokens, outputTokens: stats.outputTokens, cost: stats.cost }
			: null,
		lastActivity: meta.modifiedAt ?? meta.createdAt,
	};
}

/** 按事件更新一个会话投影；未知事件刻意保持原引用。 */
export function applyEvent(view: LanSessionView, event: SessionEvent): LanSessionView {
	const now = Date.now();
	switch (event.type) {
		case "agent_start":
			return { ...view, agentActive: true, lastActivity: now };
		case "agent_end":
		case "agent_settled":
			return { ...view, agentActive: false, currentTool: null, lastActivity: now };
		case "message_start":
			return event.message.role === "user" ? { ...view, lastActivity: now } : view;
		case "message_update": {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta") {
				return {
					...view,
					assistantTail: trimTail(`${view.assistantTail ?? ""}${update.delta}`),
					lastActivity: now,
				};
			}
			if (update.type === "toolcall_start") {
				return {
					...view,
					currentTool: toolNameFromPartial(update.partial, update.contentIndex),
					lastActivity: now,
				};
			}
			return view;
		}
		case "tool_execution_start":
			return { ...view, currentTool: event.toolName, lastActivity: now };
		case "tool_execution_end": {
			const todos =
				event.toolName === "todo" && !event.isError
					? extractTodos((event.result as { details?: unknown } | null | undefined)?.details)
					: null;
			return {
				...view,
				currentTool: null,
				todos: todos ?? view.todos,
				lastError: event.isError ? errorText(event.result) : view.lastError,
				lastActivity: now,
			};
		}
		case "compaction_start":
			return { ...view, compacting: true, lastActivity: now };
		case "compaction_end":
			return {
				...view,
				compacting: false,
				lastError: event.errorMessage ?? view.lastError,
				lastActivity: now,
			};
		case "queue_update":
			return { ...view, queued: event.followUp.length > 0 };
		default:
			return view;
	}
}

/** 权限请求进入时替换会话上的醒目等待态。 */
export function applyPermissionRequest(view: LanSessionView, req: PermissionRequest): LanSessionView {
	return {
		...view,
		pendingPermission: { title: req.title, message: req.message, kind: req.kind },
		lastActivity: Date.now(),
	};
}

/** 权限请求被桌面端应答后清除等待态。 */
export function applyPermissionResolved(view: LanSessionView): LanSessionView {
	return view.pendingPermission ? { ...view, pendingPermission: null, lastActivity: Date.now() } : view;
}

function trimTail(text: string | null): string | null {
	if (!text) return null;
	return text.slice(-TAIL_LIMIT);
}

function toolNameFromPartial(partial: unknown, contentIndex: number): string {
	const content = (partial as { content?: Array<{ type?: string; name?: string }> } | undefined)?.content;
	for (let index = contentIndex; index >= 0; index--) {
		const block = content?.[index];
		if (block?.type === "toolCall" && block.name) return block.name;
	}
	return "tool";
}

function errorText(result: unknown): string {
	if (typeof result === "string") return result.slice(-TAIL_LIMIT);
	const value = result as { content?: unknown; error?: unknown; message?: unknown } | null | undefined;
	for (const candidate of [value?.error, value?.message, value?.content]) {
		if (typeof candidate === "string" && candidate) return candidate.slice(-TAIL_LIMIT);
	}
	return "Tool execution failed";
}
