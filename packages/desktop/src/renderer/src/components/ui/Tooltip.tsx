import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { anchorOfElement, placeMenu } from "./place-menu";

const BUBBLE_CLASS =
	"pointer-events-none z-50 rounded-md bg-white px-2 py-1 text-ui-11 text-ink shadow-pop dark:bg-black";

/** 受控提示挂到 body，避免被选项列表的 overflow 裁剪。 */
function AnchoredTooltip({
	label,
	id,
	anchor,
}: {
	label: string;
	id?: string;
	anchor: RefObject<HTMLSpanElement | null>;
}) {
	const bubble = useRef<HTMLSpanElement>(null);
	const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
	const [visible, setVisible] = useState(false);
	useLayoutEffect(() => {
		const update = () => {
			if (!anchor.current || !bubble.current) return;
			setPosition(
				placeMenu(anchorOfElement(anchor.current), bubble.current.getBoundingClientRect(), {
					width: window.innerWidth,
					height: window.innerHeight,
				}),
			);
		};
		update();
		const timer = window.setTimeout(() => setVisible(true), 300);
		window.addEventListener("scroll", update, true);
		window.addEventListener("resize", update);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("scroll", update, true);
			window.removeEventListener("resize", update);
		};
	}, [anchor]);
	return createPortal(
		<span
			ref={bubble}
			id={id}
			role="tooltip"
			className={`${BUBBLE_CLASS} fixed w-max max-w-[min(280px,calc(100vw-12px))] whitespace-normal text-left leading-relaxed [overflow-wrap:anywhere]`}
			style={{
				left: position?.x ?? 0,
				top: position?.y ?? 0,
				visibility: visible && position ? "visible" : "hidden",
			}}
		>
			{label}
		</span>,
		document.body,
	);
}

/** 轻量自定义 tooltip，替代原生 title（延迟不可控/跟随鼠标/系统样式）：
   悬停 300ms 后淡入（防扫过闪烁），离开立即消失；固定锚在触发元素下方居中。
   纯色悬浮卡片：浅色纯白 / 深色纯黑 + 悬浮阴影（无边框）

   注意：气泡即使 opacity-0 也始终渲染，绝对定位盒子会计入滚动容器的
   scrollable overflow —— 居中锚点在容器右缘（或左缘）时会撑出幻影横向滚动条。
   靠右缘的触发元素用 align="end"（气泡右对齐、向左伸展，不溢出右缘）；
   靠左缘的用 align="start"（气泡左对齐、向右伸展，不溢出左缘）。 */
export function Tooltip({
	label,
	align = "center",
	multiline = false,
	className,
	open,
	id,
	children,
}: {
	label: string;
	/** 气泡水平锚定：center = 居中（默认）；start = 左缘对齐（左缘元素用，不向左溢出）；end = 右缘对齐（右缘元素用，不向右溢出） */
	align?: "center" | "start" | "end";
	/** 长段落：气泡限宽换行（默认单行不换行） */
	multiline?: boolean;
	/** 追加到触发元素包裹层（如 w-full 让栅格内的禁用输入撑满） */
	className?: string;
	/** 受控模式：在滚动容器外定位并限宽换行；省略时保留原有 hover 用法。 */
	open?: boolean;
	id?: string;
	children: ReactNode;
}) {
	const anchor = useRef<HTMLSpanElement>(null);
	return (
		<span
			ref={anchor}
			className={`group/tooltip relative ${open === undefined ? "inline-flex shrink-0" : "flex"} ${className ?? ""}`}
		>
			{children}
			{open !== undefined ? (
				open && <AnchoredTooltip key={label} label={label} id={id} anchor={anchor} />
			) : (
				<span
					role="tooltip"
					className={`${BUBBLE_CLASS} absolute top-full mt-1.5 opacity-0 transition-opacity duration-150 group-hover/tooltip:opacity-100 group-hover/tooltip:delay-300 ${
						multiline
							? "w-max max-w-[280px] whitespace-normal text-left leading-relaxed"
							: "whitespace-nowrap"
					} ${align === "end" ? "right-0" : align === "start" ? "left-0" : "left-1/2 -translate-x-1/2"}`}
				>
					{label}
				</span>
			)}
		</span>
	);
}
