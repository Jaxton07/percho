import { LAN_IMAGE_PLACEHOLDER, type SessionEvent, type SessionMessage } from "@percho/shared";

/**
 * LAN 白名单投影（spec §5.5）：剥除手机端不需要且敏感的字段——
 * base64 图片（保数量占位）、sourceText（桌面撤回匹配用）、本地路径
 * （subagent sessionFile/artifactsDir、mutex extensionPath、show_image paths）。
 * 纯函数；事件帧 stripping 后无残余语义（或非白名单类型）返回 null 丢弃。
 */

const PLACEHOLDER_IMAGE = { data: LAN_IMAGE_PLACEHOLDER, mimeType: "image/x-lan-stripped" };

/** 客户端真实消费的事件类型白名单（= shared transcript reducer 处理的类型）；其余一律丢弃。 */
const FORWARDABLE_EVENTS = new Set([
	"agent_start",
	"turn_start",
	"message_start",
	"message_update",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"turn_end",
	"agent_end",
	"agent_settled",
	"queue_update",
	"compaction_start",
	"compaction_end",
	"subagent_mutex",
]);

function placeholderImages(images: unknown): { data: string; mimeType: string }[] {
	if (!Array.isArray(images)) return [];
	return images.map(() => ({ ...PLACEHOLDER_IMAGE }));
}

/** 剥离 details 中的图片与本地路径（show_image 的 images/paths、subagent 的 sessionFile/artifactsDir）。 */
function sanitizeDetails(details: unknown): unknown {
	if (!details || typeof details !== "object") return details;
	const d = details as Record<string, unknown>;
	let out: Record<string, unknown> | null = null;
	const set = (key: string, value: unknown) => {
		if (!out) out = { ...d };
		out[key] = value;
	};
	if (Array.isArray(d.images)) set("images", placeholderImages(d.images));
	if (typeof d.image === "string") set("image", LAN_IMAGE_PLACEHOLDER);
	if (d.image && typeof d.image === "object") set("image", { ...PLACEHOLDER_IMAGE });
	if (Array.isArray(d.paths)) set("paths", []);
	if (typeof d.path === "string") set("path", "");
	if (Array.isArray(d.results)) {
		set(
			"results",
			d.results.map((run: unknown) => {
				if (!run || typeof run !== "object") return run;
				const { sessionFile: _sf, artifactsDir: _ad, ...rest } = run as Record<string, unknown>;
				return rest;
			}),
		);
	}
	return out ?? details;
}

/** content 块数组中的 image 块替换为占位（保数量），其余原样。 */
function sanitizeContentBlocks(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((block: unknown) => {
		if (block && typeof block === "object" && (block as { type?: string }).type === "image") {
			return { ...(block as Record<string, unknown>), ...PLACEHOLDER_IMAGE };
		}
		return block;
	});
}

/** pi AgentMessage（user/assistant/toolResult/custom）递归 sanitize；非对象原样返回。 */
function sanitizeAgentMessage(message: unknown): unknown {
	if (!message || typeof message !== "object") return message;
	const m = message as Record<string, unknown>;
	let out: Record<string, unknown> | null = null;
	const set = (key: string, value: unknown) => {
		if (!out) out = { ...m };
		out[key] = value;
	};
	if (Array.isArray(m.content)) set("content", sanitizeContentBlocks(m.content));
	if (m.details) set("details", sanitizeDetails(m.details));
	return out ?? message;
}

/** 历史消息 sanitize（snapshot transcripts 用）。 */
export function sanitizeSessionMessage(message: SessionMessage): SessionMessage {
	if (message.role === "user") {
		const { sourceText: _st, ...rest } = message;
		return { ...rest, images: placeholderImages(message.images) };
	}
	if (message.role === "assistant") {
		return { ...message, images: placeholderImages(message.images) };
	}
	if (message.role === "image") {
		// show_image 历史：占位保留（客户端显示图片占位），本地路径剥除
		return { ...message, images: placeholderImages(message.images), paths: [] };
	}
	// subagent 结果消息：剥本地路径
	return {
		...message,
		runs: message.runs.map((run) => {
			const { sessionFile: _sf, artifactsDir: _ad, ...rest } = run;
			return rest;
		}),
	};
}

/** SSE event 帧 sanitize；返回 null = 丢弃该帧（非白名单类型）。 */
export function sanitizeSessionEvent(event: SessionEvent): SessionEvent | null {
	if (!FORWARDABLE_EVENTS.has(event.type)) return null;
	if (event.type === "subagent_mutex") {
		return { ...event, extensionPath: "" };
	}
	if (event.type === "message_start" || event.type === "message_update") {
		return { ...event, message: sanitizeAgentMessage(event.message) as typeof event.message };
	}
	if (event.type === "turn_end") {
		return {
			...event,
			message: sanitizeAgentMessage(event.message) as typeof event.message,
			toolResults: event.toolResults.map(
				(result) => sanitizeAgentMessage(result) as (typeof event.toolResults)[number],
			),
		};
	}
	if (event.type === "agent_end") {
		return {
			...event,
			messages: event.messages.map(
				(message) => sanitizeAgentMessage(message) as (typeof event.messages)[number],
			),
		};
	}
	if (event.type === "tool_execution_end") {
		// result 为工具结果对象（{content, details}）：图片/路径在 details 内
		const result = sanitizeAgentMessage(event.result);
		return result === event.result ? event : { ...event, result };
	}
	if (event.type === "tool_execution_update") {
		const partialResult = sanitizeAgentMessage(event.partialResult);
		return partialResult === event.partialResult ? event : { ...event, partialResult };
	}
	return event;
}
