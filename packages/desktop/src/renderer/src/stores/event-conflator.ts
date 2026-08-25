import type { SessionEvent } from "@percho/shared";

/**
 * 渲染端事件合流（conflation）：流式 delta 在进入 transcript store 前按帧合并。
 *
 * 问题背景：快模型流式输出可达 50–100+ delta/s，每条 delta 经 IPC 到达后各自触发一次
 * zustand set → React 渲染（每条 IPC 回调是独立 macrotask，React 自动批处理救不了）→
 * MessageList 全量 buildChatRows + 历史组件级联重渲染 + StreamingMarquee 强制布局，
 * 与状态行动画 / CenterOrb canvas 共享主线程，高峰帧被挤掉（掉帧非必现，取决于速率×历史长度）。
 *
 * 合流规则（保序、无损）：
 * - 可合并事件仅限**纯追加**型：text_delta / thinking_delta / toolcall_delta（按
 *   (sessionId, type, contentIndex) 键拼接 delta 字符串）、tool_execution_update 且
 *   partialResult 为 string（按 toolCallId 拼接；对象形 partialResult 携带子代理
 *   details，不合并）。reducer 对拼接后 delta 与逐条应用结果等价。
 * - 其余事件（边界/控制类：message_start/end、toolcall_start/end、turn_end、agent_end、
 *   权限、压缩等）到达时**先冲刷该会话挂起的增量再立即应用**——顺序语义与逐条转发完全一致。
 * - flush 由 rAF 驱动（≤1 次/帧 → React 每帧至多一次提交）；窗口隐藏时 rAF 停摆，
 *   用兜底定时器（隐藏态 Chromium 节流到 ~1/s，恰好进一步降频）。
 *
 * 时序代价：delta 上屏最多延迟一帧（~16ms），感知不可见；markstream 的平滑 pacing 在
 * 下游继续兜底。
 *
 * 事件对象所有权（隐式契约）：合流会**就地修改**首个到达的 pending 事件对象（delta 原地拼接）。
 * 当前安全前提：事件经 IPC 反序列化为每条新对象，其他 pi.onEvent 监听器（如 use-context-usage）
 * 只在收到时同步读。未来若新增「留存事件对象异步再读」的监听器，读到的是合流后的累积值。
 */

/** 窗口隐藏时 rAF 不触发，兜底 flush 间隔（后台节流后约 1s 一次，可接受） */
const HIDDEN_FALLBACK_MS = 250;

export interface EventConflatorOptions {
	apply: (sessionId: string, event: SessionEvent) => void;
	/**
	 * 调度一次 flush，返回取消函数。默认 rAF + 隐藏兜底定时器；测试注入同步调度器。
	 */
	schedule?: (flush: () => void) => () => void;
}

/** 默认调度：rAF 优先，隐藏态 rAF 停摆时定时器兜底；两者先到先 flush，另一个作废 */
const defaultSchedule = (flush: () => void): (() => void) => {
	let done = false;
	const run = () => {
		if (done) return;
		done = true;
		cancelAnimationFrame(raf);
		clearTimeout(timer);
		flush();
	};
	const raf = requestAnimationFrame(run);
	const timer = setTimeout(run, HIDDEN_FALLBACK_MS);
	return () => {
		done = true;
		cancelAnimationFrame(raf);
		clearTimeout(timer);
	};
};

/** 可合并事件 → 合并键；null = 边界/控制事件（立即透传） */
function conflatableKey(sessionId: string, event: SessionEvent): string | null {
	if (event.type === "message_update") {
		const e = (
			event as {
				assistantMessageEvent?: { type?: unknown; contentIndex?: unknown; delta?: unknown };
			}
		).assistantMessageEvent;
		if (e?.type === "text_delta" || e?.type === "thinking_delta" || e?.type === "toolcall_delta") {
			if (typeof e.delta !== "string") return null;
			// contentIndex 非 number（理论上 SDK 恒发 number）→ 不合并直接透传：reducer 里
			// textBlockIndex ?? contentIndex 对 undefined/0 语义不同，兼底 ?? 0 会错误合并
			if (typeof e.contentIndex !== "number") return null;
			return `${sessionId}|${e.type}|${e.contentIndex}`;
		}
		return null;
	}
	if (event.type === "tool_execution_update") {
		// 对象形 partialResult 可能携带子代理 details（sessionFile 回填），不合并
		if (typeof event.partialResult !== "string") return null;
		return `${sessionId}|toolout|${event.toolCallId}`;
	}
	return null;
}

/** 就地把 incoming 的追加内容并入 target（两者已确认同键、同为纯追加型） */
function mergeInto(target: SessionEvent, incoming: SessionEvent): void {
	if (target.type === "message_update" && incoming.type === "message_update") {
		const t = target as { assistantMessageEvent: { delta: string } };
		const i = incoming as { assistantMessageEvent: { delta: string } };
		t.assistantMessageEvent.delta += i.assistantMessageEvent.delta;
		return;
	}
	if (target.type === "tool_execution_update" && incoming.type === "tool_execution_update") {
		target.partialResult = (target.partialResult as string) + (incoming.partialResult as string);
	}
}

interface PendingEntry {
	sessionId: string;
	event: SessionEvent;
}

export class EventConflator {
	private readonly apply: (sessionId: string, event: SessionEvent) => void;
	private readonly schedule: (flush: () => void) => () => void;
	private pending: PendingEntry[] = [];
	/** 合并键 → pending 下标（数组保持首个到达顺序，合并原地更新） */
	private keyIndex = new Map<string, number>();
	private cancelScheduled: (() => void) | null = null;

	constructor(options: EventConflatorOptions) {
		this.apply = options.apply;
		this.schedule = options.schedule ?? defaultSchedule;
	}

	push(sessionId: string, event: SessionEvent): void {
		const key = conflatableKey(sessionId, event);
		if (key === null) {
			// 边界事件：先冲刷挂起增量（保证同会话顺序），再立即应用
			this.flushNow();
			this.apply(sessionId, event);
			return;
		}
		const idx = this.keyIndex.get(key);
		const pending = idx !== undefined ? this.pending[idx] : undefined;
		if (pending) {
			mergeInto(pending.event, event);
		} else {
			this.keyIndex.set(key, this.pending.length);
			this.pending.push({ sessionId, event });
		}
		if (!this.cancelScheduled) this.cancelScheduled = this.schedule(() => this.flushNow());
	}

	/** 立即冲刷全部挂起增量（幂等；同时取消已调度的 flush） */
	flushNow(): void {
		if (this.cancelScheduled) {
			this.cancelScheduled();
			this.cancelScheduled = null;
		}
		if (this.pending.length === 0) return;
		const batch = this.pending;
		this.pending = [];
		this.keyIndex.clear();
		for (const { sessionId, event } of batch) {
			this.apply(sessionId, event);
		}
	}

	dispose(): void {
		this.flushNow();
	}
}
