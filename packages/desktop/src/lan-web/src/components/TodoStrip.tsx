import type { TodoItem } from "@percho/shared";
import { t } from "../i18n";

/** todo 折叠条（桌面 TodoPanel 的精简 props 版）：折叠条 + 展开列表 + 进度计数 */
export function TodoStrip({ todos }: { todos: TodoItem[] }) {
	if (todos.length === 0) return null;
	const done = todos.filter((item) => item.status === "completed").length;
	return (
		<details className="todo-strip drawer-details">
			<summary>
				<span>{t("todo.title")}</span>
				<span className="todo-progress">
					{done}/{todos.length}
				</span>
			</summary>
			<div className="todo-list">
				{todos.map((item, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 全量替换列表无稳定 id，顺序稳定
					<div key={i} className={`todo-item ${item.status}`}>
						<span className="todo-icon">
							{item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○"}
						</span>
						<span>{item.content}</span>
					</div>
				))}
			</div>
		</details>
	);
}
