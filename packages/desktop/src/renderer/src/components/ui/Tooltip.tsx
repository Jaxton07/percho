import type { ReactNode } from "react";

/** 轻量自定义 tooltip，替代原生 title（延迟不可控/跟随鼠标/系统样式）：
   悬停 300ms 后淡入（防扫过闪烁），离开立即消失；固定锚在触发元素下方居中。
   纯色悬浮卡片：浅色纯白 / 深色纯黑 + 悬浮阴影（无边框） */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
	return (
		<span className="group/tooltip relative inline-flex shrink-0">
			{children}
			<span
				role="tooltip"
				className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-white px-2 py-1 text-[11px] text-ink opacity-0 shadow-pop transition-opacity duration-150 group-hover/tooltip:opacity-100 group-hover/tooltip:delay-300 dark:bg-black"
			>
				{label}
			</span>
		</span>
	);
}
