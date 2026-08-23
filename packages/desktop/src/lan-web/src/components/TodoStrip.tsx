import type { TodoItem } from "@percho/shared";
import { t } from "../i18n";
import { CheckIcon, ChevronRightIcon, CircleIcon, HalfIcon, ListIcon } from "./icons";

/** todo 折叠条（桌面 TodoPanel 的精简 props 版）。
 *  UX v2：summary 行 = list 图标 + 标题 + done/total 计数 + chevron；下方常驻渐变进度条
 * （宽 = done/total，流光动画）；展开项 ✓◐○ 字符 → check/half/circle SVG。 */
export function TodoStrip({ todos }: { todos: TodoItem[] }) {
	if (todos.length === 0) return null;
	const done = todos.filter((item) => item.status === "completed").length;
	const pct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;
	return (
		<details className="todo-bar drawer-details">
			<summary>
				<div className="todo-top">
					<ListIcon size={14} className="todo-list-icon" />
					{t("todo.title")}
					<span className="cnt">
						{done} / {todos.length}
					</span>
					<ChevronRightIcon size={13} className="meta-caret" />
				</div>
				<div className="todo-track">
					<div className="todo-fill" style={{ width: `${pct}%` }} />
				</div>
			</summary>
			<div className="todo-items">
				{todos.map((item, i) => {
					const state =
						item.status === "completed" ? "done" : item.status === "in_progress" ? "doing" : "todo";
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: 全量替换列表无稳定 id，顺序稳定
						<div key={i} className={`todo-item ${state}`}>
							<span className="t-ic">
								{state === "done" ? (
									<CheckIcon size={12} />
								) : state === "doing" ? (
									<HalfIcon size={12} />
								) : (
									<CircleIcon size={12} />
								)}
							</span>
							<span>{item.content}</span>
						</div>
					);
				})}
			</div>
		</details>
	);
}
