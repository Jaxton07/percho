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
	/** 本地稳定标识（React key 用）：创建时分配，不随 toolcall_end 改写（id 会从 "" 翻转为真实 id） */
	key: string;
	id: string;
	name: string;
	/** 参数摘要（JSON 或纯文本） */
	args: string;
	/** 执行输出累积 */
	output: string;
	state: "running" | "done" | "error";
}

/** 预览活动条目：事件流按到达顺序追加，预览行永远显示最新一条（latest-wins） */
export interface ActivityEntry {
	/** 稳定身份：thinking 为 "thinking"，tool 为 `c${contentIndex}`（turn 内唯一，跨 delta/end 不变） */
	id: string;
	kind: "thinking" | "tool";
	/** tool：工具名（toolcall_start 时已知） */
	name?: string;
	/** tool：参数摘要源文本（随 delta 增长，end 后为完整 JSON） */
	args?: string;
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
	/** 到达顺序的活动序列（thinking / tool call 穿插），预览行数据源 */
	activity: ActivityEntry[];
}

export type SessionPhase = "idle" | "streaming" | "awaiting_permission";

export interface SessionTranscriptState {
	messages: UIMessage[];
	streaming: StreamingState | null;
	phase: SessionPhase;
	/** agent 运行中（用户发消息后 → 下一次正文回复间为 true，agent 结束/中止为 false） */
	agentActive: boolean;
	/** 后台会话完成未读（agentActive true→false 时该会话未被查看则置 true；查看/重新开工清除）。reducer 不维护，由 store 层按 isActiveViewing 处理 */
	unseenCompletion: boolean;
	/** 运行中排队的 followUp 消息文本（SDK queue_update 事件整组替换；agent 完成自动投递后清空） */
	followUpQueue: string[];
}

export function emptyTranscript(): SessionTranscriptState {
	return {
		messages: [],
		streaming: null,
		phase: "idle",
		agentActive: false,
		unseenCompletion: false,
		followUpQueue: [],
	};
}

function emptyStreaming(): StreamingState {
	return { text: "", thinking: "", tools: [], activeToolIndex: -1, toolByContentIndex: {}, activity: [] };
}

let nextMessageId = 0;
function newMessageId(): string {
	return `m${nextMessageId++}`;
}

let nextToolKey = 0;
function newToolKey(): string {
	return `t${nextToolKey++}`;
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
				agentActive: true,
				streaming: emptyStreaming(),
			};
		case "turn_start": {
			// 每轮新的 assistant 消息（多轮工具循环）前重置累积容器并回到 streaming；
			// 上一轮内容已由 turn_end 提交，否则后续 message_update/tool_execution_* 会被丢弃
			return {
				...state,
				phase: "streaming",
				streaming: emptyStreaming(),
			};
		}
		case "message_start": {
			// 防御：assistant 消息开始但容器不存在时（如 turn_start 缺失）补建
			if (event.message.role === "assistant" && !state.streaming) {
				state = {
					...state,
					streaming: emptyStreaming(),
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
				case "thinking_delta": {
					// 活动序列：连续 thinking 合并为同一条目（内容从 streaming.thinking 读）
					const last = streaming.activity[streaming.activity.length - 1];
					const activity =
						last?.kind === "thinking"
							? streaming.activity
							: [...streaming.activity, { id: "thinking", kind: "thinking" as const }];
					return { ...state, streaming: { ...streaming, thinking: streaming.thinking + e.delta, activity } };
				}
				case "toolcall_start": {
					const name = toolNameFromPartial(e.partial, e.contentIndex);
					const tools = [
						...streaming.tools,
						{
							key: newToolKey(),
							id: "",
							name,
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
							activity: [
								...streaming.activity,
								{ id: `c${e.contentIndex}`, kind: "tool" as const, name, args: "" },
							],
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
					return {
						...state,
						streaming: {
							...streaming,
							tools,
							activity: updateToolActivity(streaming.activity, e.contentIndex, (a) => a + e.delta),
						},
					};
				}
				case "toolcall_end": {
					const tools = [...streaming.tools];
					const idx =
						streaming.toolByContentIndex[e.contentIndex] ??
						(streaming.activeToolIndex >= 0 ? streaming.activeToolIndex : tools.length - 1);
					const target = idx >= 0 ? idx : tools.findIndex((t) => t.id === e.toolCall.id);
					const tool = tools[target];
					if (!tool) return state;
					const args = parseArgs(e.toolCall.arguments);
					tools[target] = {
						...tool,
						id: e.toolCall.id,
						name: e.toolCall.name || tool.name,
						args,
					};
					const activity = streaming.activity.map((a) =>
						a.id === `c${e.contentIndex}` ? { ...a, name: e.toolCall.name || a.name, args } : a,
					);
					return { ...state, streaming: { ...streaming, tools, activity, activeToolIndex: -1 } };
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
			return finalizeStreaming({
				...state,
				phase: event.willRetry ? "streaming" : "idle",
				// willRetry 还会继续 → 保持工作中；否则 run 结束（含中止）
				agentActive: event.willRetry ? state.agentActive : false,
			});
		case "agent_settled":
			return finalizeStreaming({ ...state, phase: "idle", agentActive: false });
		case "queue_update":
			// SDK 整组下发（steering 桌面端不用）；投递/清空都由 SDK 侧触发后推新数组
			return { ...state, followUpQueue: [...event.followUp] };
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

/** toolcall_delta：按 contentIndex 找到 activity 条目并追加参数字段（无对应条目则原样返回） */
function updateToolActivity(
	activity: ActivityEntry[],
	contentIndex: number,
	append: (args: string) => string,
): ActivityEntry[] {
	const id = `c${contentIndex}`;
	if (!activity.some((a) => a.id === id)) return activity;
	return activity.map((a) => (a.id === id ? { ...a, args: append(a.args ?? "") } : a));
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
			key: tool.id || newToolKey(),
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
