import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";

/** 只裁剪正文的展示，不截断原文；自然高度独立于折叠状态，避免测量反馈循环。 */
export function UserMessageText({ children }: { children: ReactNode }) {
	const t = useT();
	const id = useId();
	const contentRef = useRef<HTMLDivElement>(null);
	const [overflowing, setOverflowing] = useState(false);
	const [expanded, setExpanded] = useState(false);
	// 初次测量可能被其他消息的布局读取提交；仅在用户操作后启用过渡，避免挂载时从全文收起。
	const [animate, setAnimate] = useState(false);

	useLayoutEffect(() => {
		const content = contentRef.current;
		if (!content) return;
		const measure = () => {
			const lineHeight = Number.parseFloat(getComputedStyle(content).lineHeight);
			const height = content.getBoundingClientRect().height;
			content.parentElement?.style.setProperty("--user-message-full-height", `${height}px`);
			setOverflowing(height > lineHeight * 6 + 1);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(content);
		return () => observer.disconnect();
	}, []);

	return (
		<>
			<div
				id={id}
				className="user-message-text"
				data-collapsed={overflowing && !expanded ? "true" : undefined}
				data-animate={animate ? "true" : undefined}
			>
				<div ref={contentRef} className="whitespace-pre-wrap break-words">
					{children}
				</div>
			</div>
			{overflowing && (
				<button
					type="button"
					aria-expanded={expanded}
					aria-controls={id}
					onClick={() => {
						setAnimate(true);
						setExpanded((value) => !value);
					}}
					className="mt-1 px-1 py-0.5 text-ui-12 text-ink-faint hover:text-ink select-none"
				>
					{t(expanded ? "message.showLess" : "message.showMore")}
				</button>
			)}
		</>
	);
}
