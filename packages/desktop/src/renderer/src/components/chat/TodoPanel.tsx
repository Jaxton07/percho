import type { TodoItem } from "@percho/shared";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { EMPTY_TODOS, useTranscriptStore } from "../../stores/transcript";
import { useUiStore } from "../../stores/ui";
import { TodoCompleteIcon, TodoPendingIcon, TodoSpinnerIcon } from "../icons";

/** 进度环几何参数（r=8，周长用于 dashoffset 弹性推进） */
const RING_R = 8;
const RING_C = 2 * Math.PI * RING_R;

/** 折叠态进度环：绿色 arc + hover 色轨道，dashoffset 过渡驱动进度动画 */
function TodoProgressRing({ done, total }: { done: number; total: number }) {
	const pct = total > 0 ? done / total : 0;
	return (
		<svg width="18" height="18" viewBox="0 0 20 20" className="shrink-0 -rotate-90" aria-hidden="true">
			<circle cx="10" cy="10" r={RING_R} fill="none" strokeWidth="2.5" className="stroke-hover" />
			<circle
				cx="10"
				cy="10"
				r={RING_R}
				fill="none"
				strokeWidth="2.5"
				strokeLinecap="round"
				strokeDasharray={RING_C}
				strokeDashoffset={RING_C * (1 - pct)}
				className="stroke-green-500 transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
			/>
		</svg>
	);
}

function TodoRow({ todo, spinnerPaused }: { todo: TodoItem; spinnerPaused?: boolean }) {
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
				<TodoSpinnerIcon
					size={14}
					className={`mt-[3px] shrink-0 animate-spin ${
						spinnerPaused ? "text-ink-faint [animation-play-state:paused]" : "text-ink-2"
					}`}
				/>
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

/** todo 悬浮面板：消息区右上角胶囊（呼吸灯 + Todo List + 计数 + 绿色进度环），点击展开完整列表 */
export function TodoPanel() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const todos =
		useTranscriptStore((s) => (activeSessionId ? s.bySession[activeSessionId]?.todos : undefined)) ??
		EMPTY_TODOS;
	const expanded = useUiStore((s) => (activeSessionId ? (s.todoExpanded[activeSessionId] ?? false) : false));
	const toggle = useUiStore((s) => s.toggleTodoExpanded);
	/** agent 是否在工作中（agent_start→true，agent_end/agent_settled→false；排队追问不影响）。
		停止时呼吸灯 / 转圈动画定格变淡，恢复工作时自动继续 */
	const agentActive = useTranscriptStore((s) =>
		activeSessionId ? (s.bySession[activeSessionId]?.agentActive ?? false) : false,
	);
	const t = useT();

	if (todos.length === 0 || !activeSessionId) return null;

	const done = todos.filter((x) => x.status === "completed").length;
	const allDone = done === todos.length;

	return (
		<div className="absolute top-2 right-4 z-20 max-w-[calc(100%-2rem)]">
			{/* 同一卡片容器：折叠 = 小胶囊，展开 = 面板。宽度 + 内部 grid-rows 高度同步过渡，
				形成「胶囊 ↔ 面板」的 morph 感（参考 .local/design/components/todo-panel-concepts.html 方案 A） */}
			<div
				className={`overflow-hidden rounded-xl bg-surface shadow-pop transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none ${
					expanded ? "w-64" : "w-40"
				}`}
			>
				<button
					type="button"
					onClick={() => toggle(activeSessionId)}
					aria-expanded={expanded}
					className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left"
				>
					{/* 呼吸灯：颜色取 ink（与背景相反，日间黑 / 夜间白），动画见 globals.css todo-breath-dot */}
					<span
						className={`todo-breath-dot ${agentActive ? "" : "todo-breath-dot-paused"}`}
						aria-hidden="true"
					/>
					<span className="shrink-0 text-[13px] font-medium text-ink">{t("todo.title")}</span>
					<span
						className={`shrink-0 text-[11px] tabular-nums ${allDone ? "text-green-500" : "text-ink-dim"}`}
					>
						{done}/{todos.length}
					</span>
					<span className="ml-auto shrink-0">
						<TodoProgressRing done={done} total={todos.length} />
					</span>
				</button>
				{/* body 常驻 DOM：grid-rows 0fr→1fr 在卡片内部抽拉，容器 overflow-hidden 裁剪，
					收起时高度归零、卡片缩回胶囊态（退出动画自然播放） */}
				<div
					className={`grid transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none ${
						expanded ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0"
					}`}
					aria-hidden={!expanded}
				>
					<div className="overflow-hidden">
						<ul className="todo-thin-scroll max-h-72 overflow-y-auto px-1.5 pt-1 pb-1.5">
							{todos.map((todo, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: 全量替换列表无稳定 id，顺序稳定
								<TodoRow key={i} todo={todo} spinnerPaused={!agentActive} />
							))}
						</ul>
					</div>
				</div>
			</div>
		</div>
	);
}
