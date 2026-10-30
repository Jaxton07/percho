import { isLlmErrorRound } from "./transcript/llm-errors";

/** Fixed native notification copy; never include conversation-derived content. */
export const TASK_NOTIFICATION_COPY: Record<"zh" | "en", Record<"completed" | "failed" | "test", string>> = {
	zh: { completed: "任务已完成", failed: "任务失败", test: "这是一条测试通知" },
	en: { completed: "Task completed", failed: "Task failed", test: "This is a test notification" },
};
export type NotificationLanguage = keyof typeof TASK_NOTIFICATION_COPY;
export type NotificationSendResult = "submitted" | "unsupported" | "failed";

export interface TaskNotificationTarget {
	environment: import("./environment").EnvironmentRef;
	sessionId: string;
	sessionFile?: string;
}
export interface TaskNotificationClick {
	target: TaskNotificationTarget | null;
	queued: boolean;
}

export interface TaskRunState {
	result?: "completed" | "failed";
	ended: boolean;
	paused: boolean;
	guardFailed: boolean;
}

/** Whole busy interval, including SDK-internal follow-ups and retry continuations. */
export function reduceTaskRun(
	state: TaskRunState | undefined,
	event: import("./session").SessionEvent,
): {
	state?: TaskRunState;
	outcome?: "completed" | "failed";
} {
	if (event.type === "agent_start")
		return {
			state: state
				? { ...state, result: undefined, ended: false }
				: { ended: false, paused: false, guardFailed: false },
		};
	if (!state) return {};
	if (event.type === "turn_end" && event.message.role === "assistant") {
		const message = event.message;
		const result = isLlmErrorRound(message)
			? "failed"
			: message.stopReason === "stop" || message.stopReason === "length"
				? "completed"
				: undefined;
		return { state: { ...state, result } };
	}
	if (event.type === "agent_end")
		return {
			state: { ...state, ended: !event.willRetry, ...(event.willRetry ? { result: undefined } : {}) },
		};
	if (event.type === "compaction_pause") return { state: { ...state, paused: !!event.pause } };
	if (event.type === "stream_guard_tripped") return { state: { ...state, guardFailed: true } };
	if (event.type === "agent_settled")
		return {
			outcome: state.guardFailed
				? "failed"
				: event.aborted || state.paused
					? undefined
					: state.result === "failed"
						? "failed"
						: state.ended
							? state.result
							: undefined,
		};
	return { state };
}
