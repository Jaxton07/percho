import { tailOffsetForWidths } from "@percho/shared";
import { useLayoutEffect, useRef } from "react";

/**
 * 流式预览的贴尾滚动（向左滚动）：动态文本右缘贴视口右缘，最新 token 始终可见。
 * 运动数学用 shared tailOffsetForWidths（与桌面 StreamingMarquee 同一函数）；此处只做 DOM 测量。
 */
export function TailMarquee({ text }: { text: string }) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const innerRef = useRef<HTMLSpanElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: text 是刻意的重测触发信号（effect 只读 ref 测量）
	useLayoutEffect(() => {
		const wrap = wrapRef.current;
		const inner = innerRef.current;
		if (!wrap || !inner) return;
		const offset = tailOffsetForWidths(inner.scrollWidth, wrap.clientWidth);
		inner.style.transform = offset > 0 ? `translateX(${-offset}px)` : "";
	}, [text]);
	return (
		<div ref={wrapRef} className="tail-marquee" aria-hidden="true">
			<span ref={innerRef} className="tail-marquee-inner">
				{text}
			</span>
		</div>
	);
}
