import { buildLlmUiError, buildStreamGuardUiError, isUserAbortError, type UiError } from "../errors";
import type { ImageInput, SessionEvent } from "../session";
import { parseExpandedSkillInvocation } from "../skill-invocation";
import { extractSubagentRuns } from "../subagent";
import { extractTodos, TODO_TOOL_NAME } from "../todo";
import {
	emptyStreaming,
	extractEditPatch,
	extractExecutionDelta,
	extractShowImage,
	findLastIndex,
	newMessageId,
	newToolKey,
	parseArgs,
	toolNameFromPartial,
	updateThinkingActivity,
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

/** 错误卡落地 + 清 pending（agent_end 最终失败 / agent_settled 竞底 / guard trip 共用） */
function commitLlmErrorCard(state: SessionTranscriptState, error: UiError): SessionTranscriptState {
	return {
		...state,
		pendingLlmError: null,
		messages: [
			...state.messages,
			{ kind: "error" as const, id: newMessageId(), text: "", timestamp: error.timestamp, error },
		],
	};
}

/**
 * pi 事件 → UI 状态 reducer。
 * 事件经 IPC 原样转发（AgentSessionEvent），本函数纯函数化应用。
 */
export function reduceEvent(state: SessionTranscriptState, event: SessionEvent): SessionTranscriptState {
	switch (event.type) {
		case "stream_guard_tripped": {
			// 熔断显形：warning 卡（含 verdict detail）；同轮 pending 的 LLM 错误卡不再落（熔断卡是唯一解释）
			// 先 finalize 再落卡——熔断发生在流式中途（message_update 触发），partial 正文必须先固化在卡前
			const card = buildStreamGuardUiError(event.verdict);
			const final = finalizeStreaming(state);
			return {
				...final,
				pendingLlmError: null,
				messages: [
					...final.messages,
					{ kind: "error" as const, id: newMessageId(), text: "", timestamp: card.timestamp, error: card },
				],
			};
		}
		case "subagent_mutex": {
			// 同一扩展的通知只保留一条：每次 openSession 都会重发互斥事件，而 loadHistory 会保留系统通知
			if (
				state.messages.some(
					(message) => message.kind === "system" && message.mutex?.extensionPath === event.extensionPath,
				)
			)
				return state;
			return {
				...state,
				messages: [
					...state.messages,
					{
						kind: "system" as const,
						id: newMessageId(),
						text: "",
						timestamp: Date.now(),
						mutex: { extensionPath: event.extensionPath, tools: event.tools },
					},
				],
			};
		}
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
			const invocation = parseExpandedSkillInvocation(text);
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
						text: invocation ? (invocation.args ?? "") : text,
						images,
						timestamp: event.message.timestamp ?? Date.now(),
						...(invocation
							? {
									skill: { name: invocation.name, args: invocation.args },
									sourceText: text,
								}
							: {}),
					},
				],
			};
		}
		case "message_update": {
			const streaming = state.streaming;
			if (!streaming) return state;
			const e = event.assistantMessageEvent;
			switch (e.type) {
				case "text_delta": {
					const text = streaming.text + e.delta;
					return {
						...state,
						streaming: {
							...streaming,
							text,
							// 首个非空正文块位置 = 正文起点锚
							textBlockIndex: text ? (streaming.textBlockIndex ?? e.contentIndex) : null,
						},
					};
				}
				case "thinking_delta":
					return {
						...state,
						streaming: {
							...streaming,
							thinking: streaming.thinking + e.delta,
							activity: updateThinkingActivity(streaming.activity, e.contentIndex, (text) => text + e.delta),
						},
					};
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
					const activity = streaming.activity.map((entry) =>
						entry.id === `c${e.contentIndex}` && entry.kind === "tool"
							? { ...entry, name: e.toolCall.name || entry.name, args }
							: entry,
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
			// subagent：单代理或 parallel tasks 都从折叠区移出建独立工作中行；
			// management（action）/workflowScript（可能后台）/subagent_wait 不走独立行。
			const startArgs = (event.args ?? {}) as {
				action?: unknown;
				agent?: unknown;
				task?: unknown;
				tasks?: Array<{ agent?: unknown; task?: unknown }>;
			};
			const parallelTasks = Array.isArray(startArgs.tasks) ? startArgs.tasks : [];
			const runInputs =
				event.toolName === "subagent" && startArgs.action == null
					? typeof startArgs.agent === "string"
						? [{ agent: startArgs.agent, task: startArgs.task }]
						: parallelTasks.filter((task) => typeof task.agent === "string")
					: [];
			if (runInputs.length > 0) {
				const start = streaming.subagentRuns.length;
				const runs: SubagentRunUi[] = runInputs.map((input, index) => ({
					key: `${event.toolCallId}:${index}`,
					agent: typeof input.agent === "string" && input.agent.length > 0 ? input.agent : "subagent",
					task: typeof input.task === "string" && input.task.length > 0 ? input.task : undefined,
					status: "running",
				}));
				// ticker 摘条（spec §9.0）：subagent 不进 Working 预览行——toolcall_start 已在
				// activity 留了 `c${blockIndex}` 条目，移出折叠区时同步摘除
				const removedTool = streaming.tools.find((t) => t.id === event.toolCallId);
				const activity =
					removedTool?.blockIndex != null
						? streaming.activity.filter((a) => a.id !== `c${removedTool.blockIndex}`)
						: streaming.activity;
				return {
					...state,
					streaming: {
						...streaming,
						tools: streaming.tools.filter((t) => t.id !== event.toolCallId),
						activity,
						subagentRuns: [...streaming.subagentRuns, ...runs],
						subagentByToolCallId: {
							...streaming.subagentByToolCallId,
							[event.toolCallId]: { start, count: runs.length },
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
			const placement = streaming.subagentByToolCallId[event.toolCallId];
			const progress = placement
				? extractSubagentRuns((event.partialResult as { details?: unknown } | null | undefined)?.details)
				: null;
			let subagentRuns = streaming.subagentRuns;
			if (placement && progress) {
				// 子会话在 runner 创建后立即通过 partialResult 上报 sessionFile；只回填路径，
				// 保住 running 状态（其 exitCode=-1，不能被 extract 的 error 判定覆盖）。
				const next = [...subagentRuns];
				for (const update of progress) {
					if (!update.sessionFile) continue;
					const index = next.findIndex(
						(run, i) =>
							i >= placement.start &&
							i < placement.start + placement.count &&
							run.sessionFile == null &&
							run.agent === update.agent &&
							(update.task == null || run.task === update.task),
					);
					const current = index >= 0 ? next[index] : undefined;
					if (current) next[index] = { ...current, sessionFile: update.sessionFile };
				}
				subagentRuns = next;
			}
			if (!delta && subagentRuns === streaming.subagentRuns) return state;
			const rawToolOutputs = delta
				? {
						...streaming.rawToolOutputs,
						[event.toolCallId]:
							(streaming.rawToolOutputs?.[event.toolCallId] ??
								streaming.tools.find((tool) => tool.id === event.toolCallId)?.output ??
								"") + delta,
					}
				: streaming.rawToolOutputs;
			const tools = delta
				? streaming.tools.map((tool) =>
						tool.id === event.toolCallId
							? { ...tool, output: rawToolOutputs?.[event.toolCallId] ?? "" }
							: tool,
					)
				: streaming.tools;
			return { ...state, streaming: { ...streaming, tools, rawToolOutputs, subagentRuns } };
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
			const placement = streaming.subagentByToolCallId[event.toolCallId];
			if (placement !== undefined || (extracted && extracted.length > 0)) {
				// 独立子代理行：已知占位更新 / 结构检测兜底；一次调用可有多个子代理（fanout）
				const start = placement?.start ?? streaming.subagentRuns.length;
				const count = placement?.count ?? 0;
				const before = streaming.subagentRuns.slice(0, start);
				const after = placement ? streaming.subagentRuns.slice(start + count) : [];
				const placeholders = placement ? streaming.subagentRuns.slice(start, start + count) : [];
				const runs: SubagentRunUi[] =
					extracted && extracted.length > 0
						? extracted.map((run, index) => ({ ...run, key: `${event.toolCallId}:${index}` }))
						: placeholders.map((placeholder) => ({
								key: placeholder.key,
								agent: placeholder.agent,
								task: placeholder.task,
								status: event.isError ? ("error" as const) : ("done" as const),
							}));
				// ticker 摘条（兑底分支同 spec §9.0）：start 未建占位时工具仍在折叠区/activity 里
				const endedTool = streaming.tools.find((t) => t.id === event.toolCallId);
				const activity =
					endedTool?.blockIndex != null
						? streaming.activity.filter((a) => a.id !== `c${endedTool.blockIndex}`)
						: streaming.activity;
				return {
					...next,
					streaming: {
						...streaming,
						tools: streaming.tools.filter((t) => t.id !== event.toolCallId),
						activity,
						subagentRuns: [...before, ...runs, ...after],
					},
				};
			}
			// edit 工具成功 → 存 unified patch（turn-diff chip / diff 侧栏数据源）
			const editPatch = event.toolName === "edit" && !event.isError ? extractEditPatch(event.result) : null;
			const tools = streaming.tools.map((t) =>
				t.id === event.toolCallId
					? {
							...t,
							state: (event.isError ? "error" : "done") as "error" | "done",
							...(editPatch ? { diff: editPatch } : {}),
						}
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
		case "auto_retry_start":
			// 自动重试瞬时状态行（不落卡；成功恢复不留痕，最终失败由 turn_end/agent_end 落卡）
			return {
				...state,
				retrying: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs },
			};
		case "auto_retry_end":
			return { ...state, retrying: null };
		case "turn_end": {
			const final = finalizeStreaming({ ...state, phase: "idle" });
			// LLM 错误轮：不当场落卡，挂 pending 等 agent_end 的 willRetry 判定（决策 D1：
			// SDK 每个 retry 轮都发 turn_end(error)，只有最终失败才落卡）
			const message = event.message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
			if (
				message?.role === "assistant" &&
				message.stopReason === "error" &&
				typeof message.errorMessage === "string" &&
				message.errorMessage.length > 0 &&
				// 用户主动中断的取消错误（SDK 标成 error）不产卡：这是中断不是失败（见 errors.ts 判定注释）
				!isUserAbortError(message.errorMessage)
			) {
				return { ...final, pendingLlmError: buildLlmUiError(message.errorMessage) };
			}
			return final;
		}
		case "agent_end": {
			const final = finalizeStreaming({
				...state,
				phase: event.willRetry ? "streaming" : "idle",
				// willRetry 还会继续 → 保持工作中；否则 run 结束（含中止）
				agentActive: event.willRetry ? state.agentActive : false,
			});
			// 决策 D1：willRetry=true → 继续重试，丢弃本轮的 pending 错误卡；
			// willRetry=false → 最终失败，落卡（位置 = 该轮 assistant 消息之后）
			if (final.pendingLlmError && !event.willRetry) return commitLlmErrorCard(final, final.pendingLlmError);
			return final.pendingLlmError ? { ...final, pendingLlmError: null } : final;
		}
		case "agent_settled": {
			// 竞赛路径竞底：agent_end 缺失时（异常流）pending 仍要落卡，不留隐患。
			// 正常路径 agent_end 已处理（willRetry=false 落卡 / true 丢弃），此处 pending 恒为 null，零成本检查
			const final = finalizeStreaming({ ...state, phase: "idle", agentActive: false, retrying: null });
			return final.pendingLlmError ? commitLlmErrorCard(final, final.pendingLlmError) : final;
		}
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
