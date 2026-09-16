/**
 * V2 实测：reduceEvent 服务端（LAN projector）单会话 CPU 成本。
 * 合成典型长会话事件流（10 轮 × ~1000 事件：流式 delta 为主 + 工具/队列/压缩混合），
 * 顺序喂 reduceEvent 测总时长与单事件均摊。
 * 运行：cd packages/backend && npx tsx test/bench-reducer.ts
 */
import type { SessionEvent } from "@percho/shared";
import { emptyTranscript, reduceEvent } from "@percho/shared";

function synthEvents(rounds: number): SessionEvent[] {
	const events: SessionEvent[] = [];
	for (let r = 0; r < rounds; r++) {
		events.push({ type: "agent_start" });
		events.push({ type: "message_start", message: { role: "user", content: `question ${r}` } });
		events.push({ type: "message_start", message: { role: "assistant", content: [] } });
		// 流式 delta：每次 4 字符 × 600
		for (let i = 0; i < 600; i++) {
			events.push({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					id: `msg-${r}`,
					delta: "text",
				},
			} as SessionEvent);
		}
		// 工具调用轮
		events.push({ type: "tool_execution_start", toolName: "bash", toolCallId: `tc-${r}` });
		events.push({
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: `tc-${r}`,
			isError: false,
			result: "ok",
		});
		events.push({ type: "queue_update", followUp: [] });
		events.push({ type: "agent_end" });
	}
	return events;
}

const events = synthEvents(Number(process.env.ROUNDS ?? 10));
console.log("events:", events.length);

// 预热一轮（JIT）
{
	let s = emptyTranscript();
	for (const e of events) s = reduceEvent(s, e);
}

for (const run of [1, 2, 3]) {
	const t0 = performance.now();
	let state = emptyTranscript();
	for (const e of events) state = reduceEvent(state, e);
	const t1 = performance.now();
	const ms = t1 - t0;
	console.log(
		`run${run}: total ${ms.toFixed(1)}ms, per-event ${(ms / events.length).toFixed(2)}µs, messages=${state.messages.length}, streaming=${state.agentActive}`,
	);
}
