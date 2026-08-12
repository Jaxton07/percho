/** todo 工具任务状态（全量替换协议，Claude Code TodoWrite 同款） */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** 单条任务（v1 只留 content + status 两个字段，不加 priority） */
export interface TodoItem {
	content: string;
	status: TodoStatus;
}

/** todo 工具名（backend 注册、extension 监听、renderer 分流三处共用） */
export const TODO_TOOL_NAME = "todo";

/** compaction 后注入的恢复消息 customType（getTodos 扫历史时识别） */
export const TODO_REMINDER_CUSTOM_TYPE = "todo-reminder";

/**
 * 从工具结果 details 提取 todo 列表（结构检测：details.todos 数组）。
 * 前后端共用：backend 注入/getTodos 提取，renderer 面板数据提取。
 * 命中返回规整后的列表（空数组 = 清空，合法），结构不符返回 null。
 */
export function extractTodos(details: unknown): TodoItem[] | null {
	const d = details as { todos?: unknown } | null | undefined;
	if (!d || !Array.isArray(d.todos)) return null;
	const items: TodoItem[] = [];
	for (const raw of d.todos) {
		const item = raw as { content?: unknown; status?: unknown } | null | undefined;
		if (!item || typeof item.content !== "string" || item.content.length === 0) continue;
		if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") {
			continue;
		}
		items.push({ content: item.content, status: item.status });
	}
	return items;
}
