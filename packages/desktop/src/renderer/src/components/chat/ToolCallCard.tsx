import { useEffect, useRef, useState } from "react";
import type { UIToolCall } from "../../stores/transcript";
import { ExpandArrowIcon } from "../icons";

export function summarizeArgs(args: string): string {
	if (!args || args === "{}") return "";
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		const command = parsed.command ?? parsed.cmd;
		if (typeof command === "string") return command;
		const filePath = parsed.filePath ?? parsed.path ?? parsed.file;
		if (typeof filePath === "string") return filePath;
	} catch {
		// 非 JSON，原样展示
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

	// args 在工具调用创建后不变，只测量一次 + 监听行宽变化
	useEffect(() => {
		const check = () => {
			const el = textRef.current;
			const row = rowRef.current;
			if (!el || !row) return;
			const left = el.getBoundingClientRect().left - row.getBoundingClientRect().left;
			setOverflowing(el.scrollWidth > row.clientWidth - left);
		};
		check();
		const row = rowRef.current;
		if (!row) return;
		const ro = new ResizeObserver(check);
		ro.observe(row);
		return () => ro.disconnect();
	}, []);

	const nameClass =
		"shrink-0 font-mono text-[13px] font-semibold text-ink-dim transition-colors group-hover/row:text-ink";
	const summaryClass =
		"relative overflow-hidden whitespace-nowrap font-mono text-[12px] text-ink-faint transition-colors group-hover/row:text-ink";

	return (
		<details className="group/dets">
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
					<pre className="max-h-56 overflow-y-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-dim select-text">
						{tool.args}
					</pre>
				)}
				{tool.output && (
					<pre className="max-h-56 overflow-y-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2 select-text">
						{tool.output}
					</pre>
				)}
			</div>
		</details>
	);
}
