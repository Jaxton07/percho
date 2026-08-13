import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { extractTodos, TODO_REMINDER_CUSTOM_TYPE, TODO_TOOL_NAME, type TodoItem } from "@percho/shared";
import { formatTodoList } from "./todo-tool";

/**
 * 内置 todo 恢复扩展：compaction 后把当前 todo 列表自动注入上下文。
 * 每会话一份闭包状态（inline factory）：
 * - tool_execution_end：todo 工具成功后记录最新列表（全量替换）
 * - session_compact：标记需要提醒（compaction 会截断历史 toolResult）
 * - context：下次 LLM 调用前注入 reminder CustomMessage（display:false，模型可见）。
 *   用 context 而非 before_agent_start：overflow 恢复时 willRetry 在同一 run 内重试，
 *   before_agent_start 不会再触发，而 context 每次 LLM 调用前都触发。
 */
export function makeTodoReminderExtension(): InlineExtension {
	return {
		name: "todo-reminder",
		factory: (pi) => {
			let currentTodos: TodoItem[] = [];
			let needsReminder = false;

			pi.on("tool_execution_end", (event) => {
				if (event.toolName !== TODO_TOOL_NAME || event.isError) return;
				const todos = extractTodos((event.result as { details?: unknown } | undefined)?.details);
				if (todos) currentTodos = todos;
			});

			pi.on("session_compact", () => {
				needsReminder = true;
			});

			pi.on("context", (event) => {
				if (!needsReminder || currentTodos.length === 0) return;
				needsReminder = false;
				return {
					messages: [
						...event.messages,
						{
							role: "custom",
							customType: TODO_REMINDER_CUSTOM_TYPE,
							content: `The conversation history was compacted. Continue working on this task list:\n${formatTodoList(currentTodos)}`,
							display: false,
							details: { todos: currentTodos },
							timestamp: Date.now(),
						},
					],
				};
			});
		},
	};
}
