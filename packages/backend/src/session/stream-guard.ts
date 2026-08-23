import type { SessionEvent } from "@percho/shared";

/** 熔断判定结果：pass=放行；suppress=已熔断丢弃本条；trip_*=本次触发熔断（调用方应 abort 会话） */
export type StreamGuardVerdict = "pass" | "suppress" | "trip_whitespace" | "trip_oversize";

export interface StreamGuardLimits {
	/** 连续纯空白增量字节数上限（模型卡死在空白 thinking/text 洪流，0.4.6 事故形态） */
	wsRunBytes: number;
	/** 单条流式消息增量总量上限（任何形式的失控增长兜底） */
	totalBytes: number;
}

export const DEFAULT_STREAM_GUARD_LIMITS: StreamGuardLimits = {
	// 正常文本不可能连续 8KB 只出空白字符（代码缩进也夹非空白）；事故洪流几秒内即触发
	wsRunBytes: 8 * 1024,
	// 2MB ≈ 70 万 token 输出，远超任何 max_tokens 上限；write/edit 工具参数也到不了这个量
	totalBytes: 2 * 1024 * 1024,
};

interface GuardState {
	wsRun: number;
	total: number;
	tripped: boolean;
}

/**
 * 流式输出熔断：SDK/模型侧无 thinking 长度上限，病态流（纯空白 delta 无限输出）
 * 会拖垮 trace 落盘与 IPC 转发。在 emitEvent 单点对每条 assistant 增量计数：
 * 触发后丢弃该消息后续 message_update（trace 与转发同步止血），由调用方 abort 会话。
 * 计数在 assistant message_start / message_end 重置；非流式事件零开销直通。
 * 状态清理双路径：agent_end/agent_settled 自删（subagent 会话不走 closeSession，
 * 靠这层防 Map 随 subagent 运行次数无界增长）+ closeSession 显式 cleanup（中途关会话）。
 */
export class StreamGuard {
	private readonly states = new Map<string, GuardState>();

	constructor(private readonly limits: StreamGuardLimits = DEFAULT_STREAM_GUARD_LIMITS) {}

	inspect(sessionId: string, event: SessionEvent): StreamGuardVerdict {
		if (event.type === "agent_end" || event.type === "agent_settled") {
			// run 结束即释放计数状态；后续若有新 run 会重建全新状态（与消息边界重置等价）
			this.states.delete(sessionId);
			return "pass";
		}
		const st = this.stateOf(sessionId);
		if (event.type === "message_start" || event.type === "message_end") {
			// 消息边界重置（user/toolResult 边界重置无害：期间本就没有 delta）
			st.wsRun = 0;
			st.total = 0;
			st.tripped = false;
			return "pass";
		}
		if (event.type !== "message_update") return "pass";
		if (st.tripped) return "suppress";

		const e = (event as { assistantMessageEvent?: { type?: unknown; delta?: unknown } })
			.assistantMessageEvent;
		if (e?.type !== "text_delta" && e?.type !== "thinking_delta" && e?.type !== "toolcall_delta") {
			return "pass";
		}
		const delta = typeof e.delta === "string" ? e.delta : "";
		st.total += delta.length;
		st.wsRun = delta.trim() === "" ? st.wsRun + delta.length : 0;
		if (st.wsRun > this.limits.wsRunBytes) {
			st.tripped = true;
			return "trip_whitespace";
		}
		if (st.total > this.limits.totalBytes) {
			st.tripped = true;
			return "trip_oversize";
		}
		return "pass";
	}

	/** 会话关闭时清理计数状态（agent_end 自删之外的兜底：streaming 中途关会话时无 agent_end） */
	cleanup(sessionId: string): void {
		this.states.delete(sessionId);
	}

	private stateOf(sessionId: string): GuardState {
		let st = this.states.get(sessionId);
		if (!st) {
			st = { wsRun: 0, total: 0, tripped: false };
			this.states.set(sessionId, st);
		}
		return st;
	}
}
