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

/** 单 text 块超过该字节数 → 截断保头（诊断价值：开头是命令/文件上下文） */
const TEXT_TRUNCATE_AT = 16 * 1024;
const TEXT_KEEP_HEAD = 4 * 1024;
/** image block 的 base64 超过该字节数 → 剥除换占位（图片终态无下游消费者，见下） */
const IMAGE_DATA_STRIP_AT = 512;

/**
 * toolResult 终态载荷瘦身（0.5.2 白屏事故降压层）：read 图片等大结果会被
 * tool_execution_end / message_start / message_end / turn_end 四份快照重复携带，
 * trace 落盘 + IPC 转发同步放大 4×（实测 504KB×4 ≈ 2MB/次，小时级累计把 renderer 压垮）。
 * 在 emitEvent 单点、分发给 trace/IPC/LAN 之前剥除：
 * - content[].image 的 base64 data → 占位标记（下游零消费：renderer 工具卡 output 走
 *   tool_execution_update 增量、show_image 发图走 details.images、LAN sanitize 本就剥 data）
 * - content[].text 超长 → 截断保头（renderer/LAN 均不读 content 数组正文；trace replay 同构）
 * - details 一律不动（todos / subagent / edit patch / show_image 均在 details，UI 数据源）
 * - assistant / user 消息终态不动（UI 固化与历史回放的权威数据源）
 */
export function slimBulkyEvent(event: SessionEvent): SessionEvent {
	switch (event.type) {
		case "tool_execution_end":
			return replace(event, "result", slimToolResult((event as { result?: unknown }).result));
		case "message_start":
		case "message_end": {
			const message = (event as { message?: unknown }).message;
			if ((message as { role?: unknown } | undefined)?.role !== "toolResult") return event;
			return replace(event, "message", slimToolResult(message));
		}
		case "turn_end": {
			// turn_end.message 为 assistant 终态（UI 固化数据源）不动；toolResults 数组逐个瘦身
			const toolResults = (event as { toolResults?: unknown[] }).toolResults;
			if (!Array.isArray(toolResults)) return event;
			let changed = false;
			const next = toolResults.map((r) => {
				const slim = slimToolResult(r);
				if (slim !== r) changed = true;
				return slim;
			});
			return changed ? ({ ...event, toolResults: next } as SessionEvent) : event;
		}
		default:
			return event;
	}
}

/** 就地替换字段；值未变时返回原事件（引用稳定，避免无谓拷贝） */
function replace<T extends object, K extends string>(obj: T, key: K, value: unknown): T {
	return (obj as Record<string, unknown>)[key] === value ? obj : ({ ...obj, [key]: value } as T);
}

/** toolResult 载荷（{content, details} 形状）瘦身；非对象/无 content 数组原样返回 */
function slimToolResult(r: unknown): unknown {
	if (!r || typeof r !== "object") return r;
	const content = (r as { content?: unknown }).content;
	if (!Array.isArray(content)) return r;
	let changed = false;
	const next = content.map((b) => {
		if (!b || typeof b !== "object") return b;
		const block = b as { type?: unknown; data?: unknown; text?: unknown };
		if (block.type === "image" && typeof block.data === "string" && block.data.length > IMAGE_DATA_STRIP_AT) {
			changed = true;
			return { ...block, data: `[image data stripped: ${block.data.length}B]` };
		}
		if (block.type === "text" && typeof block.text === "string" && block.text.length > TEXT_TRUNCATE_AT) {
			changed = true;
			const head = block.text.slice(0, TEXT_KEEP_HEAD);
			return { ...block, text: `${head}\n[tool output truncated: kept 4KB of ${block.text.length}B]` };
		}
		return b;
	});
	return changed ? ({ ...r, content: next } as object) : r;
}
