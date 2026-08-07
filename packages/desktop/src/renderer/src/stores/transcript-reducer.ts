import type { AgentSessionEvent, ImageInput, SessionMessage } from "@pi-desktop/shared";

/** 单条 UI 消息 */
export type UIMessage =
	| {
			kind: "user";
			id: string;
			text: string;
			images: ImageInput[];
			timestamp: number;
	  }
	| { kind: "assistant"; id: string; text: string; thinking: string; tools: UIToolCall[]; timestamp: number }
	| { kind: "error"; id: string; text: string; timestamp: number }
	| { kind: "system"; id: string; text: string; timestamp: number; compact?: CompactionUiState };

/** 上下文压缩系统消息状态（compaction_start → compaction_end 更新同一条） */
export interface CompactionUiState {
	status: "running" | "done" | "cancelled" | "error";
	reason: "manual" | "threshold" | "overflow";
	summary?: string;
	tokensBefore?: number;
	tokensAfter?: number;
	errorMessage?: string;
}

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
	/** 最近一次 toolcall_start 的工具索引 */
	activeToolIndex: number;
	/** assistant 消息 content 绝对索引 → tools 数组索引（事件带 contentIndex，须按此匹配） */
	toolByContentIndex: Record<number, number>;
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
	const content = (partial as { content?: Array<{ type?: string; name?: string }> } | undefined)?.content;
	const block = content?.[contentIndex];
	if (block?.type === "toolCall" && block.name) return block.name;
	for (let i = contentIndex - 1; i >= 0; i--) {
		const prev = content?.[i];
		if (prev?.type === "toolCall" && prev.name) return prev.name;
	}
	return "tool";
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
				streaming: { text: "", thinking: "", tools: [], activeToolIndex: -1, toolByContentIndex: {} },
			};
		case "turn_start": {
			// 每轮新的 assistant 消息（多轮工具循环）前重置累积容器并回到 streaming；
			// 上一轮内容已由 turn_end 提交，否则后续 message_update/tool_execution_* 会被丢弃
			return {
				...state,
				phase: "streaming",
				streaming: { text: "", thinking: "", tools: [], activeToolIndex: -1, toolByContentIndex: {} },
			};
		}
		case "message_start": {
			// 防御：assistant 消息开始但容器不存在时（如 turn_start 缺失）补建
			if (event.message.role === "assistant" && !state.streaming) {
				state = {
					...state,
					streaming: { text: "", thinking: "", tools: [], activeToolIndex: -1, toolByContentIndex: {} },
				};
			}
			if (event.message.role !== "user") return state;
			const content = event.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter((c) => c.type === "text")
							.map((c) => (c as { text: string }).text)
							.join("");
			const images: ImageInput[] = Array.isArray(content)
				? content
						.filter((c) => c.type === "image" && (c as { data?: string }).data)
						.map((c) => ({
							data: (c as { data: string }).data,
							mimeType: (c as { mimeType?: string }).mimeType ?? "image/png",
						}))
				: [];
			return {
				...state,
				messages: [
					...state.messages,
					{ kind: "user", id: newMessageId(), text, images, timestamp: Date.now() },
				],
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
					const toolByContentIndex = {
						...streaming.toolByContentIndex,
						[e.contentIndex]: tools.length - 1,
					};
					return {
						...state,
						streaming: {
							...streaming,
							tools,
							toolByContentIndex,
							activeToolIndex: tools.length - 1,
						},
					};
				}
				case "toolcall_delta": {
					const tools = [...streaming.tools];
					const idx =
						streaming.toolByContentIndex[e.contentIndex] ??
						(streaming.activeToolIndex >= 0 ? streaming.activeToolIndex : tools.length - 1);
					const tool = tools[idx];
					if (!tool) return state;
					tools[idx] = { ...tool, args: tool.args + e.delta };
					return { ...state, streaming: { ...streaming, tools } };
				}
				case "toolcall_end": {
					const tools = [...streaming.tools];
					const idx =
						streaming.toolByContentIndex[e.contentIndex] ??
						(streaming.activeToolIndex >= 0 ? streaming.activeToolIndex : tools.length - 1);
					const target = idx >= 0 ? idx : tools.findIndex((t) => t.id === e.toolCall.id);
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
		case "compaction_start": {
			const pending: UIMessage = {
				kind: "system",
				id: `compaction-${Date.now()}-${state.messages.length}`,
				text: "",
				timestamp: Date.now(),
				compact: { status: "running", reason: event.reason },
			};
			return { ...state, messages: [...state.messages, pending] };
		}
		case "compaction_end": {
			const info: CompactionUiState = event.aborted
				? { status: "cancelled", reason: event.reason }
				: event.errorMessage
					? { status: "error", reason: event.reason, errorMessage: event.errorMessage }
					: {
							status: "done",
							reason: event.reason,
							summary: event.result?.summary,
							tokensBefore: event.result?.tokensBefore,
							tokensAfter: event.result?.estimatedTokensAfter,
						};
			// 更新进行中的压缩消息（同一 id），否则追加
			const idx = findLastIndex(
				state.messages,
				(m) => m.kind === "system" && m.compact?.status === "running",
			);
			if (idx >= 0) {
				const messages = state.messages.map((m, i) =>
					i === idx ? ({ ...m, compact: info } as UIMessage) : m,
				);
				return { ...state, messages };
			}
			const entry: UIMessage = {
				kind: "system",
				id: `compaction-${Date.now()}-${state.messages.length}`,
				text: "",
				timestamp: Date.now(),
				compact: info,
			};
			return { ...state, messages: [...state.messages, entry] };
		}
		default:
			return state;
	}
}

function findLastIndex<T>(arr: readonly T[], predicate: (item: T) => boolean): number {
	for (let i = arr.length - 1; i >= 0; i--) {
		const item = arr[i];
		if (item && predicate(item)) return i;
	}
	return -1;
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

/** 历史消息 → UI 消息（打开历史会话时回放） */
export function messagesToUIMessages(messages: SessionMessage[]): UIMessage[] {
	const ui: UIMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m) continue;
		const id = `h${i}`;
		if (m.role === "user") {
			if (m.text || m.images.length > 0) {
				ui.push({ kind: "user", id, text: m.text, images: m.images, timestamp: m.timestamp });
			}
			continue;
		}
		const tools: UIToolCall[] = m.tools.map((tool) => ({
			id: tool.id,
			name: tool.name,
			args: tool.args,
			output: tool.output,
			state: tool.isError ? "error" : "done",
		}));
		ui.push({ kind: "assistant", id, text: m.text, thinking: m.thinking, tools, timestamp: m.timestamp });
	}
	return ui;
}
