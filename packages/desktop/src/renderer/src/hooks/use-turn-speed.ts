import type { LiveEstimate, TurnSpeedSnapshot, TurnSpeedView } from "@percho/shared";
import { buildTurnSpeedView, estimateStreamingTokens, toSpeedMessage } from "@percho/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getExecutionApi } from "../environment-api";
import { useTranscriptStore } from "../stores/transcript";

export type { LiveEstimate, TurnSpeedView } from "@percho/shared";

/** 触发刷新的事件（流式 delta 类高频事件不刷新；message_end 只在 assistant 消息时刷新） */
const REFRESH_EVENTS = new Set([
	"message_end",
	"turn_end",
	"agent_settled",
	"session_info_changed",
	"compaction_end",
]);

/** 观测 TTFT 的上限（防跨轮残留与无界增长） */
const MAX_TTFT_SAMPLES = 64;
/** live 估算的滚动窗口、最短可测跨度与采样节拍 */
const LIVE_WINDOW_MS = 4_000;
const LIVE_MIN_SPAN_MS = 800;
const LIVE_TICK_MS = 500;

/**
 * Token 生成速度 hook（宿主能力；插件经 window.PerchoUI.hooks.useTurnSpeed 使用）。
 *
 * 三条数据链（口径语义与样本过滤全在 shared/transcript/turn-speed，纯函数可测）：
 * 1. 权威聚合：后端 `getTurnSpeed` 读会话分支（`usage.output` / `durationMs`），事件驱动刷新；
 * 2. decode 拆分：本 hook 观测「首个内容 delta 到达 − assistant.message.timestamp」= 实测 prefill，
 *    与后端逐条样本**尾部对齐** zip（观测只覆盖 hook 挂载后 live 看到的消息，它们排在末尾）。
 *    远程环境跨机时钟偏移时 split 自动落空 → 退回 api 口径，不出假数；
 * 3. live：流式期间每 500ms 采样 transcript 的 streaming 文本/思考/工具参数长度，CJK 加权估
 *    token，滚动 4s 窗口出瞬时速率；权威值一到即覆盖。
 */
export function useTurnSpeed(sessionId: string | null): TurnSpeedView | null {
	const [snapshot, setSnapshot] = useState<TurnSpeedSnapshot | null>(null);
	const [live, setLive] = useState<LiveEstimate | null>(null);
	/** 本 hook 观测到的逐条 prefill（ms）；null = 该条没观测到首 delta */
	const ttftRef = useRef<(number | null)[]>([]);
	const generationRef = useRef(0);
	const inFlightRef = useRef(false);
	const pendingRef = useRef(false);

	/**
	 * 权威快照刷新（合并并发请求）：message_end 与 turn_end 常同时到达，长会话每次都要遍历分支，
	 * 因此在途期间只置 pending，回来后补一轮——保证最后一拍（agent_settled）不被丢弃。
	 */
	const refresh = useCallback(async () => {
		if (inFlightRef.current) {
			pendingRef.current = true;
			return;
		}
		inFlightRef.current = true;
		for (;;) {
			pendingRef.current = false;
			const generation = ++generationRef.current;
			if (!sessionId) {
				setSnapshot(null);
				break;
			}
			try {
				const next = await getExecutionApi(sessionId).getTurnSpeed({ sessionId });
				if (generation === generationRef.current) setSnapshot(next);
			} catch {
				if (generation === generationRef.current) setSnapshot(null);
			}
			if (!pendingRef.current) break;
		}
		inFlightRef.current = false;
	}, [sessionId]);

	useEffect(() => {
		ttftRef.current = [];
		setLive(null);
		void refresh();
		return () => {
			generationRef.current += 1;
		};
	}, [refresh]);

	// 事件订阅：权威刷新 + TTFT 观测（同一消息的 message_start → 首个 delta → message_end）
	useEffect(() => {
		if (!sessionId) return;
		let firstDeltaAt: number | undefined;
		let off: (() => void) | undefined;
		try {
			off = getExecutionApi(sessionId).onEvent(({ sessionId: sid, event }) => {
				if (sid !== sessionId) return;
				if (event.type === "message_start") {
					firstDeltaAt = undefined;
					// 新轮边界：清空观测，避免与上一轮尾部错位对齐（与 deriveTurnTimings 同规则）
					if (event.message.role === "user") ttftRef.current = [];
					return;
				}
				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent;
					if (
						firstDeltaAt === undefined &&
						(delta?.type === "text_delta" ||
							delta?.type === "thinking_delta" ||
							delta?.type === "toolcall_delta")
					) {
						firstDeltaAt = Date.now();
					}
					return;
				}
				if (event.type === "message_end") {
					if (event.message.role !== "assistant") return;
					// 槽位必须与后端样本数组同规则：失败尝试/零输出被后端过滤，这里也不能占位，
					// 否则尾部对齐会错位（重试轮的 prefill 会被安到别的消息上）
					const raw = event.message as unknown as {
						usage?: { output?: unknown };
						durationMs?: unknown;
						stopReason?: unknown;
					};
					if (
						toSpeedMessage({
							output: raw.usage?.output,
							durationMs: raw.durationMs,
							stopReason: raw.stopReason,
						}) === null
					) {
						firstDeltaAt = undefined;
						void refresh();
						return;
					}
					// pi 定义：assistant.timestamp = 请求发起时刻；同机同源可比，跨机不可比（split 落空）
					const startedAt = event.message.timestamp;
					const observedAt = firstDeltaAt;
					const ttft =
						observedAt !== undefined && typeof startedAt === "number" ? observedAt - startedAt : null;
					ttftRef.current = [...ttftRef.current, ttft].slice(-MAX_TTFT_SAMPLES);
					firstDeltaAt = undefined;
					void refresh();
					return;
				}
				if (REFRESH_EVENTS.has(event.type)) void refresh();
			});
		} catch {
			// 环境 API 不可用（无 preload 的测试宿主 / 环境已销毁）：不订阅；刷新路径自带保护
			return;
		}
		return off;
	}, [sessionId, refresh]);

	// live 估算：节拍采样 streaming 长度（不订阅 store 值进 React，避免每个 delta 触发重渲染）
	useEffect(() => {
		if (!sessionId) return;
		let streamingId = "";
		let lastTokens = 0;
		let reported: LiveEstimate | null = null;
		const ring: { at: number; tokens: number }[] = [];

		const reset = (): void => {
			streamingId = "";
			lastTokens = 0;
			ring.length = 0;
		};

		const tick = (): void => {
			const entry = useTranscriptStore.getState().bySession[sessionId];
			const streaming = entry?.streaming ?? null;
			if (!streaming || !entry?.agentActive) {
				if (reported !== null) {
					reported = null;
					setLive(null);
				}
				return;
			}
			if (streaming.id !== streamingId) {
				reset();
				streamingId = streaming.id;
			}
			const tokens = estimateStreamingTokens([
				streaming.text,
				streaming.thinking,
				...streaming.tools.map((tool) => tool.args ?? ""),
			]);
			if (tokens === lastTokens) return;
			lastTokens = tokens;
			const now = Date.now();
			ring.push({ at: now, tokens });
			while (ring.length > 1) {
				const head = ring[0];
				if (!head || now - head.at <= LIVE_WINDOW_MS) break;
				ring.shift();
			}
			const first = ring[0];
			if (!first) return;
			const span = now - first.at;
			// 跨度不足 → 瞬时速率不可信：沿用上一次速率，只更新累计 token
			const speed =
				ring.length >= 2 && span >= LIVE_MIN_SPAN_MS
					? (tokens - first.tokens) / (span / 1000)
					: (reported?.speed ?? 0);
			if (speed <= 0) return;
			reported = { tokens, speed };
			setLive(reported);
		};

		const id = window.setInterval(tick, LIVE_TICK_MS);
		return () => window.clearInterval(id);
	}, [sessionId]);

	return buildTurnSpeedView(snapshot, ttftRef.current, live);
}
