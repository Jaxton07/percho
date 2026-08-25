import type { ReactNode } from "react";

/** 轻量自定义 tooltip，替代原生 title（延迟不可控/跟随鼠标/系统样式）：
   悬停 300ms 后淡入（防扫过闪烁），离开立即消失；固定锚在触发元素下方居中。
   纯色悬浮卡片：浅色纯白 / 深色纯黑 + 悬浮阴影（无边框）

   注意：气泡即使 opacity-0 也始终渲染，绝对定位盒子会计入滚动容器的
   scrollable overflow —— 居中锚点在滚动容器右缘时会撑出幻影横向滚动条。
   靠右缘的触发元素请用 align="end"（气泡右对齐、向左伸展，不溢出右缘）。 */
export function Tooltip({
	label,
	align = "center",
	className,
	children,
}: {
	label: string;
	/** 气泡水平锚定：center = 居中（默认）；end = 右缘对齐（右缘元素用，不向右溢出） */
	align?: "center" | "end";
	/** 追加到触发元素包裹层（如 w-full 让栅格内的禁用输入撑满） */
	className?: string;
	children: ReactNode;
}) {
	return (
		<span className={`group/tooltip relative inline-flex shrink-0 ${className ?? ""}`}>
			{children}
			<span
				role="tooltip"
				className={`pointer-events-none absolute top-full z-50 mt-1.5 whitespace-nowrap rounded-md bg-white px-2 py-1 text-[11px] text-ink opacity-0 shadow-pop transition-opacity duration-150 group-hover/tooltip:opacity-100 group-hover/tooltip:delay-300 dark:bg-black ${
					align === "end" ? "right-0" : "left-1/2 -translate-x-1/2"
				}`}
			>
				{label}
			</span>
		</span>
	);
}
