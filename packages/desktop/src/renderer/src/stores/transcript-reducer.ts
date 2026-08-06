import type { AgentSessionEvent } from "@pi-desktop/shared";

/** 单条 UI 消息 */
export type UIMessage =
	| { kind: "user"; id: string; text: string; timestamp: number }
	| { kind: "assistant"; id: string; text: string; thinking: string; tools: UIToolCall[]; timestamp: number }
	| { kind: "error"; id: string; text: string; timestamp: number };

/** 工具调用卡片状态 */
export interface UIToolCall {
	id: string;
	name: string;
	/** 参数摘要（JSON 或纯文本） */
	args: string;
	/** 执行输出累积 */
	output: string;
	state: "running" | "done" | "error";
}

/** 进行中的流式累积 */
export interface StreamingState {
	text: string;
	thinking: string;
	tools: UIToolCall[];
	/** 正在流式累积参数的最后一个工具索引 */
	activeToolIndex: number;
}

export type SessionPhase = "idle" | "streaming" | "awaiting_permission";

export interface SessionTranscriptState {
	messages: UIMessage[];
	streaming: StreamingState | null;
	phase: SessionPhase;
}

export function emptyTranscript(): SessionTranscriptState {
	return { messages: [], streaming: null, phase: "idle" };
}

let nextMessageId = 0;
function newMessageId(): string {
	return `m${nextMessageId++}`;
}

function parseArgs(raw: unknown): string {
	if (typeof raw !== "string") return JSON.stringify(raw ?? {});
	try {
		const parsed = JSON.parse(raw);
		return JSON.stringify(parsed, null, 0);
	} catch {
		return raw;
	}
}

function toolNameFromPartial(partial: unknown, contentIndex: number): string {
	const toolCalls = (partial as { toolCalls?: Array<{ name?: string }> } | undefined)?.toolCalls;
	const tool = toolCalls?.[contentIndex];
	if (tool?.name) return tool.name;
	const last = toolCalls?.[toolCalls.length - 1];
	return last?.name || "tool";
}

function finalizeStreaming(state: SessionTranscriptState): SessionTranscriptState {
	const { streaming, messages } = state;
	if (!streaming) return state;
	const hasContent = streaming.text.length > 0 || streaming.thinking.length > 0 || streaming.tools.length > 0;
	if (!hasContent) return { ...state, streaming: null };
	return {
		...state,
		messages: [
			...messages,
			{
				kind: "assistant",
				id: newMessageId(),
				text: streaming.text,
				thinking: streaming.thinking,
				tools: streaming.tools,
				timestamp: Date.now(),
			},
		],
		streaming: null,
	};
}

/**
 * pi 事件 → UI 状态 reducer。
 * 事件经 IPC 原样转发（AgentSessionEvent），本函数纯函数化应用。
 */
export function reduceEvent(state: SessionTranscriptState, event: AgentSessionEvent): SessionTranscriptState {
	switch (event.type) {
		case "agent_start":
			return {
				...state,
				phase: "streaming",
				streaming: { text: "", thinking: "", tools: [], activeToolIndex: -1 },
			};
		case "message_start": {
			if (event.message.role !== "user") return state;
			const content = event.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter((c) => c.type === "text")
							.map((c) => (c as { text: string }).text)
							.join("");
			return {
				...state,
				messages: [...state.messages, { kind: "user", id: newMessageId(), text, timestamp: Date.now() }],
			};
		}
		case "message_update": {
			const streaming = state.streaming;
			if (!streaming) return state;
			const e = event.assistantMessageEvent;
			switch (e.type) {
				case "text_delta":
					return { ...state, streaming: { ...streaming, text: streaming.text + e.delta } };
				case "thinking_delta":
					return { ...state, streaming: { ...streaming, thinking: streaming.thinking + e.delta } };
				case "toolcall_start": {
					const tools = [
						...streaming.tools,
						{
							id: "",
							name: toolNameFromPartial(e.partial, e.contentIndex),
							args: "",
							output: "",
							state: "running" as const,
						},
					];
					return { ...state, streaming: { ...streaming, tools, activeToolIndex: tools.length - 1 } };
				}
				case "toolcall_delta": {
					const tools = [...streaming.tools];
					const idx = streaming.activeToolIndex >= 0 ? streaming.activeToolIndex : tools.length - 1;
					const tool = tools[idx];
					if (!tool) return state;
					tools[idx] = { ...tool, args: tool.args + e.delta };
					return { ...state, streaming: { ...streaming, tools } };
				}
				case "toolcall_end": {
					const tools = [...streaming.tools];
					const idx = tools.findIndex((t) => t.id === e.toolCall.id);
					const target = idx >= 0 ? idx : streaming.activeToolIndex;
					const tool = tools[target];
					if (!tool) return state;
					tools[target] = {
						...tool,
						id: e.toolCall.id,
						name: e.toolCall.name || tool.name,
						args: parseArgs(e.toolCall.arguments),
					};
					return { ...state, streaming: { ...streaming, tools, activeToolIndex: -1 } };
				}
				default:
					return state;
			}
		}
		case "tool_execution_start": {
			const streaming = state.streaming;
			if (!streaming) return state;
			const tools = streaming.tools.map((t) =>
				t.id === event.toolCallId ? { ...t, state: "running" as const } : t,
			);
			return { ...state, streaming: { ...streaming, tools } };
		}
		case "tool_execution_update": {
			const streaming = state.streaming;
			if (!streaming) return state;
			const delta = extractExecutionDelta(event.partialResult);
			if (!delta) return state;
			const tools = streaming.tools.map((t) =>
				t.id === event.toolCallId ? { ...t, output: t.output + delta } : t,
			);
			return { ...state, streaming: { ...streaming, tools } };
		}
		case "tool_execution_end": {
			const streaming = state.streaming;
			if (!streaming) return state;
			const tools = streaming.tools.map((t) =>
				t.id === event.toolCallId
					? { ...t, state: (event.isError ? "error" : "done") as "error" | "done" }
					: t,
			);
			return { ...state, streaming: { ...streaming, tools } };
		}
		case "turn_end":
			return finalizeStreaming({ ...state, phase: "idle" });
		case "agent_end":
			return finalizeStreaming({ ...state, phase: event.willRetry ? "streaming" : "idle" });
		case "agent_settled":
			return finalizeStreaming({ ...state, phase: "idle" });
		default:
			return state;
	}
}

function extractExecutionDelta(partialResult: unknown): string | null {
	if (partialResult == null) return null;
	if (typeof partialResult === "string") return partialResult;
	const partial = partialResult as Record<string, unknown>;
	const output = partial.output;
	if (typeof output === "string" && output.length > 0) return output;
	const text = partial.text;
	if (typeof text === "string" && text.length > 0) return text;
	return null;
}
