import type { UiError } from "../errors";
import type { SessionMessage } from "../session";
import { subagentUiStatus } from "../subagent";
import { newSubagentKey, newToolKey } from "./helpers";
import { buildRoundErrorCard, isLlmErrorRound } from "./llm-errors";
import type { UIMessage, UIToolCall } from "./types";

/** 历史消息 → UI 消息（打开历史会话时回放；backend 已按 entryId 配对、正文/工具拆分） */
export function messagesToUIMessages(
	messages: SessionMessage[],
	{ recovering = false }: { recovering?: boolean } = {},
): UIMessage[] {
	const ui: UIMessage[] = [];
	// 省略只是模型上下文事实：必须还有后续尝试或已知实时恢复，才能不显示该次失败。
	// 溢出恢复可能先省略再压缩失败；缺少继续证据的历史尾错误仍按最终失败保留。
	const recovered = new Set<number>();
	let continuation = recovering;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "user") continuation = false;
		else if (message?.role === "assistant") {
			if (message.errorOmitted && continuation) recovered.add(i);
			continuation = true;
		}
	}
	// 连续 error assistant（SDK 重试轮在 jsonl 里是连续的，中间无其他消息——实测 V2 场景 1 user + 3
	// 条 assistant(error)）只留最后一张卡；遇到任何非 error 消息或流结束先落卡（与 live 的
	// agent_end willRetry 判定语义一致，决策 D1）。
	let pendingError: UiError | null = null;
	let pendingErrorId: string | undefined;
	const flushError = () => {
		if (!pendingError) return;
		ui.push({
			kind: "error" as const,
			id: pendingErrorId ?? `e${ui.length}`,
			text: "",
			timestamp: pendingError.timestamp,
			error: pendingError,
		});
		pendingError = null;
		pendingErrorId = undefined;
	};
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m) continue;
		const id = m.historyId ?? `h${i}`;
		if (m.role === "compaction") {
			// 重开会话回放的压缩分割线（实时路径由 compaction_start/end 事件产生）。
			// 不 flushError：与实时同序 —— 溢出恢复的压缩发生在 pending 错误卡落卡之前，
			// 分割线先出现、错误卡随后落（与 reducer 的 agent_end 落卡时机一致）
			ui.push({
				kind: "system",
				id,
				text: "",
				timestamp: m.timestamp,
				compact: {
					status: "done",
					...(m.summary ? { summary: m.summary } : {}),
					...(typeof m.tokensBefore === "number" ? { tokensBefore: m.tokensBefore } : {}),
				},
			});
			continue;
		}
		if (m.role === "image") {
			flushError();
			ui.push({
				kind: "image",
				id,
				images: m.images,
				paths: m.paths,
				timestamp: m.timestamp,
				...(m.entryId ? { entryId: m.entryId } : {}),
				...(m.ownerSessionId ? { ownerSessionId: m.ownerSessionId } : {}),
			});
			continue;
		}
		if (m.role === "subagent") {
			flushError();
			ui.push({
				kind: "subagent",
				id,
				runs: m.runs.map((run, index) => ({
					...run,
					status: subagentUiStatus(run.status),
					key: m.historyId ? `${id}:run:${index}` : newSubagentKey(),
				})),
				timestamp: m.timestamp,
			});
			continue;
		}
		if (m.role === "user") {
			flushError();
			const text = m.text;
			const sourceText = m.sourceText;
			if (m.skill || text || m.images.length > 0) {
				ui.push({
					kind: "user",
					id,
					text,
					images: m.images,
					timestamp: m.timestamp,
					entryId: m.entryId,
					skill: m.skill,
					document: m.document,
					...(sourceText !== undefined ? { sourceText } : {}),
				});
			}
			continue;
		}
		const text = m.text;
		const sourceText = m.sourceText;
		const tools: UIToolCall[] = m.tools.map((tool, index) => ({
			key: m.historyId ? `${id}:tool:${index}` : tool.id || newToolKey(),
			id: tool.id,
			name: tool.name,
			args: tool.args,
			output: tool.output,
			...(tool.diff ? { diff: tool.diff } : {}),
			...(tool.endedAt !== undefined ? { endedAt: tool.endedAt } : {}),
			state: tool.isError ? "error" : "done",
		}));
		const assistant: UIMessage = {
			kind: "assistant",
			...(m.generation !== undefined ? { generation: m.generation } : {}),
			id,
			text,
			thinking: m.thinking,
			tools,
			timestamp: m.timestamp,
			entryId: m.entryId,
			...(sourceText !== undefined ? { sourceText } : {}),
		};
		// 错误轮：partial 正文照常展示（保留），错误卡挂起——连续错误轮合并，非 error 消息或流结束才落卡
		// 判定与 reducer live 路径共用 isLlmErrorRound（决策 D1 单一事实源，llm-errors.ts）
		if (isLlmErrorRound(m) && !recovered.has(i)) {
			pendingErrorId = m.historyId ? `${m.historyId}:error` : undefined;
			pendingError = buildRoundErrorCard(m, m.timestamp);
			// 空错误回复也保留为不可见统计载体；实时重试成功后同样不能冒充完整数据。
			ui.push(assistant);
			continue;
		}
		flushError();
		ui.push(assistant);
	}
	flushError();
	return ui;
}
