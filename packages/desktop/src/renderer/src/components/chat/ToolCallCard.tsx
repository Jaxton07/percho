import { useEffect, useRef, useState } from "react";
import type { UIToolCall } from "../../stores/transcript";
import { ExpandArrowIcon } from "../icons";

/**
 * 溢出测量调度器（模块级共享）：一帧内所有卡片的测量合并成「先读后写」。
 *
 * 为什么不在 effect 里直接测：挂载长历史时同一提交里有几百张卡，每张各自读
 * getBoundingClientRect/clientWidth —— 读与 setState 引发的重渲染交替，会让每次读都
 * 落在「布局已失效」的状态上，浏览器被迫为每张卡重排整个消息流（实测切到 1278 条消息的
 * 会话，单是这些测量就 1400+ 次 getBoundingClientRect / 占该次切换耗时的一半）。
 * 调度器把读取集中到一个 rAF 的读阶段（合并为一次布局），写阶段统一 setState（一次渲染）。
 */
interface MeasureEntry {
	row: HTMLElement;
	text: HTMLElement;
	set: (overflowing: boolean) => void;
}

const measureQueue = new Map<HTMLElement, MeasureEntry>();
/** rAF 停摆（窗口隐藏/遮挡）时的兜底间隔，与 stores/event-conflator.ts 同一约定 */
const MEASURE_FALLBACK_MS = 250;
let measureScheduled = false;

function flushMeasures(): void {
	measureScheduled = false;
	const entries = [...measureQueue.values()];
	measureQueue.clear();
	const results: Array<[MeasureEntry, boolean]> = [];
	// 读阶段：不插入任何写入，后续测量命中同一份布局
	for (const entry of entries) {
		const { row, text } = entry;
		if (!row.isConnected || !text.isConnected) continue;
		const left = text.getBoundingClientRect().left - row.getBoundingClientRect().left;
		results.push([entry, text.scrollWidth > row.clientWidth - left]);
	}
	// 写阶段：一批 setState（React 自动批处理 → 同帧一次渲染）
	for (const [entry, overflowing] of results) entry.set(overflowing);
}

function scheduleMeasure(entry: MeasureEntry): void {
	measureQueue.set(entry.row, entry);
	if (measureScheduled) return;
	measureScheduled = true;
	// rAF 优先（读阶段贴近本帧布局），隐藏态 rAF 停摆时定时器兜底——否则队列会一直卡着不 flush
	let done = false;
	const run = () => {
		if (done) return;
		done = true;
		cancelAnimationFrame(raf);
		clearTimeout(timer);
		flushMeasures();
	};
	const raf = requestAnimationFrame(run);
	const timer = setTimeout(run, MEASURE_FALLBACK_MS);
}

/** 行元素 → 测量项（RO 回调要重测的是「已测量过」的行，队列里可能已清空，故另存持久表） */
const rowEntries = new WeakMap<HTMLElement, MeasureEntry>();

/** 共享 ResizeObserver：行宽/字号变化后重测（原本每张卡一个 RO，长历史下观测器数量随消息数线性增长） */
const rowResizeObserver =
	typeof ResizeObserver === "undefined"
		? null
		: new ResizeObserver((entries) => {
				for (const entry of entries) {
					if (!(entry.target instanceof HTMLElement)) continue;
					const known = rowEntries.get(entry.target);
					if (known) scheduleMeasure(known);
				}
			});

export function summarizeArgs(args: string): string {
	if (!args || args === "{}") return "";
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		const command = parsed.command ?? parsed.cmd;
		if (typeof command === "string") return command;
		const filePath = parsed.filePath ?? parsed.path ?? parsed.file;
		if (typeof filePath === "string") return filePath;
		const url = parsed.url;
		if (typeof url === "string") return url;
	} catch {
		// 流式中的不完整 JSON：按优先级正则抽取字段值（值允许未闭合，随流式增长原地更新）
		for (const key of ["command", "cmd", "filePath", "path", "file", "url"]) {
			const value = args.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))?.[1];
			if (value) return value;
		}
	}
	const trimmed = args.slice(0, 120);
	return trimmed.length < args.length ? `${trimmed}…` : trimmed;
}

export const displayName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** 工具调用行：无边框、默认折叠；折叠态 = 工具名 + 执行对象（单行渐变截断），展开显示完整参数与结果 */
export function ToolCallCard({ tool }: { tool: UIToolCall }) {
	const summary = summarizeArgs(tool.args);
	/** 内容是否超过一行（决定渐变 + 箭头是否贴行尾） */
	const [overflowing, setOverflowing] = useState(false);
	const textRef = useRef<HTMLSpanElement>(null);
	const rowRef = useRef<HTMLElement>(null);

	// 挂载时 args 可能为空（流式 toolcall，textRef 未渲染）→ 随 summary 变化重测；
	// overflow:hidden 下 scrollWidth 恒为内容全宽，收缩后重测结果依然正确
	// biome-ignore lint/correctness/useExhaustiveDependencies: summary 是刻意的重跑触发器（effect 内只读 ref，args 流式增长时需重测）
	useEffect(() => {
		const row = rowRef.current;
		const text = textRef.current;
		if (!row || !text) return;
		const entry: MeasureEntry = { row, text, set: setOverflowing };
		rowEntries.set(row, entry);
		rowResizeObserver?.observe(row);
		scheduleMeasure(entry);
		return () => {
			measureQueue.delete(row);
			rowEntries.delete(row);
			rowResizeObserver?.unobserve(row);
		};
	}, [summary]);

	// running 时工具名加高光扫过动画（与 MetaGroup 状态行同款光带渐变）
	const nameClass = `shrink-0 font-mono text-[13px] font-semibold text-ink-dim transition-colors group-hover/row:text-ink${
		tool.state === "running" ? " shimmer-sweep" : ""
	}`;
	const summaryClass =
		"relative overflow-hidden whitespace-nowrap font-mono text-[12px] text-ink-faint transition-colors group-hover/row:text-ink";

	return (
		<details className="group/dets drawer-details">
			<summary
				ref={rowRef}
				className="group/row flex cursor-pointer items-center gap-2 py-0.5 select-none [&::-webkit-details-marker]:hidden"
			>
				<span className={nameClass}>{displayName(tool.name)}</span>
				{summary && (
					<span
						ref={textRef}
						className={overflowing ? `${summaryClass} min-w-0 flex-1` : `${summaryClass} shrink-0`}
					>
						{summary}
						{overflowing && (
							<span className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-canvas to-transparent" />
						)}
					</span>
				)}
				{tool.state === "running" && summary && (
					<span className="shrink-0 font-mono text-[12px] text-ink-faint transition-colors group-hover/row:text-ink-2">
						…
					</span>
				)}
				<ExpandArrowIcon className="shrink-0 text-ink-faint opacity-0 transition-[opacity,transform,color] group-hover/row:opacity-100 group-hover/row:text-ink-2 group-open/dets:rotate-90" />
			</summary>
			<div className="flex flex-col gap-1.5 py-1 pl-4">
				{tool.args && (
					<pre className="max-h-56 overflow-y-auto font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap text-ink-dim select-text">
						{tool.args}
					</pre>
				)}
				{tool.output && (
					<pre className="max-h-56 overflow-y-auto font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap text-ink-2 select-text">
						{tool.output}
					</pre>
				)}
			</div>
		</details>
	);
}
