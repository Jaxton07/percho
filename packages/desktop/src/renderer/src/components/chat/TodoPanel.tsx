import type { TodoItem } from "@pi-desktop/shared";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { EMPTY_TODOS, useTranscriptStore } from "../../stores/transcript";
import { useUiStore } from "../../stores/ui";
import { TodoCompleteIcon, TodoPendingIcon, TodoSpinnerIcon } from "../icons";

/** 滑出动画时长 + 兜底清理缓冲（与 globals.css 的 todo-pill-slide-out 0.18s 同步） */
const PREV_CLEANUP_MS = 180 + 60;

/** 胶囊当前任务行：任务切换时旧行向上滑出、新行从下方滑入（latest-wins，密集切换合并为最新；初始挂载不动画） */
function TodoCurrentTask({ text }: { text: string }) {
	const [current, setCurrent] = useState(text);
	const [previous, setPrevious] = useState<string | null>(null);
	const [switched, setSwitched] = useState(false);
	const textRef = useRef(text);

	useEffect(() => {
		if (text === textRef.current) return;
		setPrevious(textRef.current);
		textRef.current = text;
		setCurrent(text);
		setSwitched(true);
	}, [text]);

	// previous 兜底清理（animation 未触发 / reduced-motion 时也能移除）
	useEffect(() => {
		if (!previous) return;
		const timer = setTimeout(() => setPrevious(null), PREV_CLEANUP_MS);
		return () => clearTimeout(timer);
	}, [previous]);

	return (
		<div className="relative h-4 min-w-0 flex-1 overflow-hidden">
			{previous && (
				<div className="todo-pill-slide-out absolute inset-x-0 top-0 truncate text-[12px] text-ink-2">
					{previous}
				</div>
			)}
			<div
				className={`${switched ? "todo-pill-slide-in" : ""} absolute inset-x-0 top-0 truncate text-[12px] text-ink-2`}
			>
				{current}
			</div>
		</div>
	);
}

function TodoRow({ todo }: { todo: TodoItem }) {
	if (todo.status === "completed") {
		return (
			<li className="flex items-start gap-2 rounded-md px-2 py-1">
				<TodoCompleteIcon size={14} className="mt-[3px] shrink-0 text-green-500" />
				<span className="min-w-0 flex-1 break-words text-[13px] leading-5 text-ink-dim line-through">
					{todo.content}
				</span>
			</li>
		);
	}
	if (todo.status === "in_progress") {
		return (
			<li className="flex items-start gap-2 rounded-md px-2 py-1">
				<TodoSpinnerIcon size={14} className="mt-[3px] shrink-0 animate-spin text-ink-2" />
				<span className="min-w-0 flex-1 break-words text-[13px] leading-5 text-ink font-medium">
					{todo.content}
				</span>
			</li>
		);
	}
	return (
		<li className="flex items-start gap-2 rounded-md px-2 py-1">
			<TodoPendingIcon size={14} className="mt-[3px] shrink-0 text-ink-faint" />
			<span className="min-w-0 flex-1 break-words text-[13px] leading-5 text-ink-2">{todo.content}</span>
		</li>
	);
}

/** todo 悬浮面板：消息区右上角胶囊（完成数/总数 + 当前任务摘要 + 细进度条），点击展开完整列表 */
export function TodoPanel() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const todos =
		useTranscriptStore((s) => (activeSessionId ? s.bySession[activeSessionId]?.todos : undefined)) ??
		EMPTY_TODOS;
	const expanded = useUiStore((s) => (activeSessionId ? (s.todoExpanded[activeSessionId] ?? false) : false));
	const toggle = useUiStore((s) => s.toggleTodoExpanded);
	const t = useT();

	if (todos.length === 0 || !activeSessionId) return null;

	const done = todos.filter((x) => x.status === "completed").length;
	const current = todos.find((x) => x.status === "in_progress");
	const allDone = done === todos.length;
	const percent = Math.round((done / todos.length) * 100);

	return (
		<div className="absolute top-2 right-4 z-20 w-60 max-w-[calc(100%-2rem)]">
			<button
				type="button"
				onClick={() => toggle(activeSessionId)}
				aria-expanded={expanded}
				className="flex w-full cursor-pointer flex-col gap-1 rounded-xl bg-surface px-3 py-2 text-left shadow-pop"
			>
				<div className="flex min-w-0 items-center gap-2">
					<span className={`shrink-0 text-[13px] font-semibold ${allDone ? "text-green-500" : "text-ink"}`}>
						{done}/{todos.length}
					</span>
					{allDone ? (
						<span className="truncate text-[12px] text-ink-2">{t("todo.allDone")}</span>
					) : (
						<TodoCurrentTask text={current ? current.content : `${t("todo.tasks")} ${todos.length}`} />
					)}
				</div>
				<div className="h-0.5 w-full overflow-hidden rounded-full bg-hover">
					<div
						className={`h-full rounded-full transition-[width] duration-300 ${allDone ? "bg-green-500" : "bg-ink-2"}`}
						style={{ width: `${percent}%` }}
					/>
				</div>
			</button>
			{/* 面板常驻 DOM：展开/收起走 grid-rows 0fr→1fr 高度过渡（上下抽拉感）+ opacity 淡入淡出，
				收起时不可见不可交互（退出动画自然播放）。grid 子项 overflow-hidden 使最小高度为 0，高度才能收缩 */}
			<div
				className={`mt-1.5 grid transition-all duration-200 ease-out motion-reduce:transition-none ${
					expanded ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0"
				}`}
				aria-hidden={!expanded}
			>
				<div className="overflow-hidden rounded-xl bg-surface shadow-pop">
					<ul className="max-h-72 overflow-y-auto p-1.5">
						{todos.map((todo, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 全量替换列表无稳定 id，顺序稳定
							<TodoRow key={i} todo={todo} />
						))}
					</ul>
				</div>
			</div>
		</div>
	);
}
