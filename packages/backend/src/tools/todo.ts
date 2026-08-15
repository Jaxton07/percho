import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TODO_TOOL_NAME, type TodoItem } from "@percho/shared";
import { Type } from "typebox";

/** 单次调用最多任务数（全量替换协议，防滥用） */
const MAX_TODOS = 50;

/**
 * 规整 todo 输入：去空 content；同时最多保留一个 in_progress（保留第一个、其余降 pending）；
 * 超出上限截断。返回规范后的列表。
 */
export function normalizeTodos(raw: TodoItem[]): TodoItem[] {
	const out: TodoItem[] = [];
	let inProgressSeen = false;
	for (const item of raw) {
		const content = item.content.trim();
		if (!content) continue;
		if (out.length >= MAX_TODOS) break;
		let status = item.status;
		if (status === "in_progress") {
			if (inProgressSeen) status = "pending";
			else inProgressSeen = true;
		}
		out.push({ content, status });
	}
	return out;
}

/** 文本清单（模型可见；空列表 = 已清空） */
export function formatTodoList(todos: TodoItem[]): string {
	return todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n");
}

const todoParams = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ minLength: 1, description: "Task description" }),
			status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
		}),
		{
			maxItems: MAX_TODOS,
			description: "The FULL updated task list (this call replaces the previous list entirely)",
		},
	),
});

/**
 * 内置 todo 工具：维护复杂多步任务的任务清单（全量替换协议，Claude Code TodoWrite 同款）。
 * 不做 todo_read：模型可见的 content 即当前清单（tool result 回显在上下文里），
 * compaction 后由 todo-reminder 扩展自动重新注入。
 */
export function makeTodoTool(): ToolDefinition<typeof todoParams> {
	return {
		name: TODO_TOOL_NAME,
		label: "Todo",
		description:
			"Maintain a task list for complex multi-step work (long refactors, multi-file features, multi-step investigations). Call with the FULL updated list on every change — the list fully replaces the previous one (there is no read tool; the latest list is always visible in this result). Keep at most ONE item in_progress at a time, mark items completed as soon as they are done, and pass an empty list when the whole task is finished.",
		promptSnippet: "todo({todos})",
		parameters: todoParams,
		execute: async (
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			_ctx,
		): Promise<AgentToolResult<{ todos: TodoItem[] }>> => {
			const todos = normalizeTodos(params.todos);
			const content =
				todos.length === 0 ? "Todo list cleared (empty)." : `Current task list:\n${formatTodoList(todos)}`;
			return {
				content: [{ type: "text", text: content }],
				details: { todos },
			};
		},
	};
}
