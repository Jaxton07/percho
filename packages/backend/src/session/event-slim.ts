import type { SessionEvent } from "@percho/shared";

/**
 * message_update 瘦身：SDK 的每条 delta 事件都携带**两份全量累积快照**
 * （`assistantMessageEvent.partial` + 顶层 `message`），流式期按条数平方放大
 * （0.4.6 冻结事故：3 分钟 12.7GB trace / renderer 堆爆）。
 *
 * 全部下游消费者（shared transcript reducer、LAN projector/server 的 delta 合并）
 * 只读 delta / contentIndex / `toolcall_start` 的 `partial`（工具名）/
 * `toolcall_end` 的 `toolCall`（id+name+arguments）——其余字段一律剥除。
 * `message_start` / `message_end` 仍携带权威全量消息，UI 终态与 trace 回放不受影响。
 */
export function slimMessageUpdate(event: SessionEvent): SessionEvent {
	if (event.type !== "message_update") return event;
	const slim = slimAssistantMessageEvent(
		(event as { assistantMessageEvent?: unknown }).assistantMessageEvent,
	);
	// 顶层 message 是第二份全量快照，一并剥除（类型上必填但无消费者，见文件头注释）
	return { type: "message_update", assistantMessageEvent: slim } as unknown as SessionEvent;
}

/** delta 白名单拷贝：只留下游实际消费的字段，快照（partial/message/content）不进新对象 */
function slimAssistantMessageEvent(e: unknown): Record<string, unknown> {
	const ev = e as {
		type?: unknown;
		contentIndex?: unknown;
		delta?: unknown;
		partial?: unknown;
		toolCall?: unknown;
	};
	switch (ev?.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return { type: ev.type, contentIndex: ev.contentIndex, delta: ev.delta };
		case "toolcall_start":
			// partial 里的 content[].name 是工具名唯一来源，保留（此时很小）
			return { type: ev.type, contentIndex: ev.contentIndex, partial: ev.partial };
		case "toolcall_end":
			return { type: ev.type, contentIndex: ev.contentIndex, toolCall: ev.toolCall };
		default:
			// start / text_start / text_end / thinking_start / thinking_end 等：
			// reducer 只用 type（部分连 type 都不看），全量 content/partial 剥除
			return ev && typeof ev.type === "string" ? { type: ev.type } : {};
	}
}
