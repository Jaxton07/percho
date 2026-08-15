import {
	type AgentSessionEvent,
	extractSubagentRuns,
	extractTodos,
	type ImageInput,
	TODO_TOOL_NAME,
} from "@percho/shared";
import {
	emptyStreaming,
	extractExecutionDelta,
	extractShowImage,
	findLastIndex,
	newMessageId,
	newSubagentKey,
	newToolKey,
	parseArgs,
	toolNameFromPartial,
	updateToolActivity,
} from "./helpers";
import type { CompactionUiState, SessionTranscriptState, SubagentRunUi, UIMessage } from "./types";

function finalizeStreaming(state: SessionTranscriptState): SessionTranscriptState {
	const { streaming, messages } = state;
	if (!streaming) return state;
	// 子代理运行：排在 assistant 消息之后落地（对齐历史回放顺序）
	const subagents: UIMessage[] =
		streaming.subagentRuns.length > 0
			? [
					{
						kind: "subagent",
						id: newMessageId(),
						runs: streaming.subagentRuns,
						timestamp: Date.now(),
					},
				]
			: [];
	// show_image 缓冲图片：排在 assistant 消息之后落地（对齐历史回放的 toolResult 顺序）
	const images: UIMessage[] = streaming.pendingImages.map((img) => ({
		kind: "image",
		id: newMessageId(),
		images: img.images,
		paths: img.paths,
		timestamp: Date.now(),
	}));
	const hasContent = streaming.text.length > 0 || streaming.thinking.length > 0 || streaming.tools.length > 0;
	if (!hasContent) {
		return images.length > 0 || subagents.length > 0
			? { ...state, messages: [...messages, ...subagents, ...images], streaming: null }
			: { ...state, streaming: null };
	}
	// 正文后到达的工具（同 turn 内 text→toolCall 交错，如“任务完成，清空列表”+todo clear）：
	// 拆成独立 meta 消息排在正文消息之后——否则渲染时会被倒挂到正文上方并进前一个折叠组（时序反转）。
	// thinking 恒归正文前组（provider 的 thinking 块总在 text 之前）；与 backend 历史回放的拆分保持一致
	const textIdx = streaming.textBlockIndex;
	const postTools = textIdx == null ? [] : streaming.tools.filter((t) => (t.blockIndex ?? 0) > textIdx);
	const preTools =
		textIdx == null ? streaming.tools : streaming.tools.filter((t) => (t.blockIndex ?? 0) < textIdx);
	const assistantMessages: UIMessage[] = [];
	if (streaming.text || streaming.thinking || preTools.length > 0) {
		assistantMessages.push({
			kind: "assistant",
			// 复用流式容器预生成的 id（key 稳定 → 不 remount，见 StreamingState.id 注释）
			id: streaming.id,
			text: streaming.text,
			thinking: streaming.thinking,
			tools: preTools,
			timestamp: Date.now(),
		});
	}
	if (postTools.length > 0) {
		assistantMessages.push({
			kind: "assistant",
			id: newMessageId(),
			text: "",
			thinking: "",
			tools: postTools,
			timestamp: Date.now(),
		});
	}
	return {
		...state,
		messages: [...messages, ...assistantMessages, ...subagents, ...images],
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
					{
						kind: "user",
						id: newMessageId(),
						text,
						images,
						timestamp: event.message.timestamp ?? Date.now(),
					},
				],
			};
		}
		case "message_update": {
			const streaming = state.streaming;
			if (!streaming) return state;
			const e = event.assistantMessageEvent;
			switch (e.type) {
				case "text_delta":
					return {
						...state,
						streaming: {
							...streaming,
							text: streaming.text + e.delta,
							// 首个 text 块位置 = 正文起点锚（后续同 turn 工具按此分前后组，见 StreamingState.textBlockIndex）
							textBlockIndex: streaming.textBlockIndex ?? e.contentIndex,
						},
					};
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
							blockIndex: e.contentIndex,
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
			// subagent：单代理直接派发（agent 参数存在、非 management action）才从折叠区移出建独立工作中行；
			// management（action）/workflowScript（可能后台）/subagent_wait 不走独立行（结果在 wait completions 或 tool 卡）
			const startArgs = (event.args ?? {}) as { action?: unknown; agent?: unknown; task?: unknown };
			if (event.toolName === "subagent" && startArgs.action == null && typeof startArgs.agent === "string") {
				const run: SubagentRunUi = {
					key: newSubagentKey(),
					agent: startArgs.agent.length > 0 ? startArgs.agent : "subagent",
					task: typeof startArgs.task === "string" && startArgs.task.length > 0 ? startArgs.task : undefined,
					status: "running",
				};
				return {
					...state,
					streaming: {
						...streaming,
						tools: streaming.tools.filter((t) => t.id !== event.toolCallId),
						subagentRuns: [...streaming.subagentRuns, run],
						subagentByToolCallId: {
							...streaming.subagentByToolCallId,
							[event.toolCallId]: streaming.subagentRuns.length,
						},
					},
				};
			}
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
			// todo 工具：全量替换会话任务列表（含空数组=清空）。不随 turn_end 清理、
			// 不被 loadHistory 重置 —— 在 streaming 守卫之前处理，容错无流式容器的情况
			let next = state;
			if (event.toolName === TODO_TOOL_NAME && !event.isError) {
				const todos = extractTodos((event.result as { details?: unknown } | null | undefined)?.details);
				if (todos) next = { ...state, todos };
			}
			const streaming = next.streaming;
			if (!streaming) return next;
			const extracted = extractSubagentRuns(
				(event.result as { details?: unknown } | null | undefined)?.details,
			);
			const start = streaming.subagentByToolCallId[event.toolCallId];
			if (start !== undefined || (extracted && extracted.length > 0)) {
				// 独立子代理行：已知占位更新 / 结构检测兜底；一次调用可有多个子代理（fanout）
				const before = streaming.subagentRuns.slice(0, start ?? streaming.subagentRuns.length);
				const after = start !== undefined ? streaming.subagentRuns.slice(start + 1) : [];
				const placeholder = start !== undefined ? streaming.subagentRuns[start] : undefined;
				const runs: SubagentRunUi[] =
					extracted && extracted.length > 0
						? extracted.map((run) => ({ ...run, key: newSubagentKey() }))
						: placeholder
							? [
									{
										key: placeholder.key,
										agent: placeholder.agent,
										task: placeholder.task,
										status: event.isError ? ("error" as const) : ("done" as const),
									},
								]
							: [];
				return {
					...next,
					streaming: {
						...streaming,
						tools: streaming.tools.filter((t) => t.id !== event.toolCallId),
						subagentRuns: [...before, ...runs, ...after],
					},
				};
			}
			const tools = streaming.tools.map((t) =>
				t.id === event.toolCallId
					? { ...t, state: (event.isError ? "error" : "done") as "error" | "done" }
					: t,
			);
			// show_image：图片先入 pendingImages 缓冲，turn_end 固化时排在 assistant 消息之后
			const shown = event.toolName === "show_image" && !event.isError ? extractShowImage(event.result) : null;
			return {
				...next,
				streaming: {
					...streaming,
					tools,
					pendingImages: shown ? [...streaming.pendingImages, shown] : streaming.pendingImages,
				},
			};
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
			return { ...state, compacting: true, messages: [...state.messages, pending] };
		}
		case "compaction_end": {
			// SDK errorMessage 自带 "Compaction failed: " 前缀，与 i18n 的「压缩失败：」重复，剥掉
			const errorMessage = event.errorMessage?.replace(/^Compaction failed:\s*/i, "");
			const info: CompactionUiState = event.aborted
				? { status: "cancelled", reason: event.reason }
				: event.errorMessage
					? { status: "error", reason: event.reason, errorMessage }
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
				return { ...state, compacting: false, messages };
			}
			const entry: UIMessage = {
				kind: "system",
				id: `compaction-${Date.now()}-${state.messages.length}`,
				text: "",
				timestamp: Date.now(),
				compact: info,
			};
			return { ...state, compacting: false, messages: [...state.messages, entry] };
		}
		default:
			return state;
	}
}
