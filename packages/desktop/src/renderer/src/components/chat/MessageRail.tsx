import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import {
	nodeAt,
	nodeY,
	RAIL_STYLE,
	type RailNode,
	tickWidth,
	viewHeight,
	visibleNodeRange,
	windowOffset,
} from "./message-rail";

interface Props {
	/** 全历史节点（只含用户消息，一轮一个），按对话顺序 */
	nodes: readonly RailNode[];
	/** 当前阅读位置所在节点序号；-1 无。只由主会话滚动位置决定，悬停不改变它 */
	activeOrdinal: number;
	onJump: (node: RailNode) => void;
	/** 导航条上的滚轮转发给对话（导航条盖在空白带上，不能吞掉滚动） */
	onWheel: (deltaY: number) => void;
	/** 左侧被别的浮层占用的宽度（会话轨道） */
	inset: number;
	/** 对话正文列：只用来确认左侧空带够宽 */
	columnRef: RefObject<HTMLElement | null>;
}

/** 少于这么多条用户消息时不显示（短会话不需要导航） */
const MIN_NODES = 3;
/** 轨道命中宽度：容纳最长的聚焦横线 + 少许余量 */
const RAIL_WIDTH = (RAIL_STYLE.widths[0] ?? 32) + 12;
/**
 * 轨道离聊天区左缘的距离。Codex 截图：轨道左端距侧栏分隔线 25 截图像素（÷1.5 ≈ 17 CSS px）。
 * 相对聊天区左缘定位，跟随侧栏宽度变化，不写死屏幕坐标。
 */
const RAIL_LEFT = 17;
/** 正文左缘与轨道之间至少留这么多，不够就不显示（窄窗口下不压正文） */
const MIN_BAND = RAIL_LEFT + RAIL_WIDTH + 16;
/** 悬停多久才出预览：鼠标只是路过轨道时不闪 */
const HOVER_DELAY_MS = 120;
/** Codex 截图：卡片宽 482、左缘距刻度左端 53 截图像素（÷1.5） */
const PREVIEW_WIDTH = 321;
const PREVIEW_OFFSET = 35;
const PREVIEW_EDGE = 12;

/**
 * 对话 Minimap（#110，以用户提供的 Codex 真实截图为视觉基准）。
 * 位置：聊天区左缘内的一条独立窄轨道，不贴正文、不参与正文布局。
 * 刻度：固定间距、左端对齐；宽度是围绕「当前阅读节点」的聚焦梯度（tickWidth / RAIL_STYLE），当前节点深色。
 * 悬停只出该节点的一张浮动卡片（标题 + 多行摘要），并在指针节点上给轻量反馈；梯度与当前高亮始终跟随阅读位置。
 * 局部窗口：可见节点数由轨道高度与间距决定；放不下时窗口跟随当前节点、到首尾贴边（windowOffset）。
 * 键盘：轨道是 listbox，上下键移动「指向」节点并显示其预览，Enter 跳转。
 */
export function MessageRail({ nodes, activeOrdinal, onJump, onWheel, inset, columnRef }: Props) {
	const t = useT();
	const railRef = useRef<HTMLDivElement>(null);
	const navRef = useRef<HTMLElement>(null);
	const [height, setHeight] = useState(0);
	const [roomy, setRoomy] = useState(true);
	// 指针下的节点（立即跟随，用于横线态）与真正显示预览的节点（延迟）分开
	const [pointer, setPointer] = useState<number | null>(null);
	const [preview, setPreview] = useState<number | null>(null);
	const [focusOrdinal, setFocusOrdinal] = useState<number | null>(null);
	const timerRef = useRef(0);
	const enough = nodes.length >= MIN_NODES;

	// 轨道高度 + 正文左侧空带是否够宽；列宽/侧栏/窗口变化时重算
	// biome-ignore lint/correctness/useExhaustiveDependencies: enough 从 false→true 时导航条刚挂上，需要首测
	useLayoutEffect(() => {
		const nav = navRef.current;
		const column = columnRef.current;
		const parent = nav?.offsetParent;
		if (!nav || !column || !(parent instanceof HTMLElement)) return;
		const measure = () => {
			const padding = Number.parseFloat(getComputedStyle(column).paddingLeft) || 0;
			const band = column.getBoundingClientRect().left + padding - parent.getBoundingClientRect().left;
			setRoomy(band - inset >= MIN_BAND);
			// 量外层可用高度（不含 py-3），可见区在其中居中
			setHeight(Math.max(0, nav.clientHeight - 24));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(column);
		observer.observe(parent);
		return () => observer.disconnect();
	}, [inset, columnRef, enough]);

	// 指针停稳才出预览；在已有预览时移到相邻节点则立即切换（不再等）
	useEffect(() => {
		window.clearTimeout(timerRef.current);
		if (pointer === null) {
			setPreview(null);
			return;
		}
		if (preview !== null) {
			setPreview(pointer);
			return;
		}
		timerRef.current = window.setTimeout(() => setPreview(pointer), HOVER_DELAY_MS);
		return () => window.clearTimeout(timerRef.current);
	}, [pointer, preview]);

	useEffect(() => {
		if (focusOrdinal !== null && focusOrdinal >= nodes.length) setFocusOrdinal(null);
	}, [focusOrdinal, nodes.length]);

	const shown = focusOrdinal ?? preview;
	// 预览按实际高度夹在视口内（上下边缘节点不会让卡片出屏）；换节点就重测
	const previewRef = useRef<HTMLDivElement>(null);
	const [previewHeight, setPreviewHeight] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: shown 变化即预览内容变化，需要重测
	useLayoutEffect(() => {
		const measured = previewRef.current?.offsetHeight ?? 0;
		if (measured !== previewHeight) setPreviewHeight(measured);
	}, [shown, previewHeight]);

	if (!enough || !roomy) return null;

	// 可见导航区：按可用高度与节点数算出高度，在轨道内垂直居中；窗口跟随当前阅读节点，
	// 键盘浏览时跟随键盘焦点（否则远端节点既看不到也没法定位预览）
	const view = viewHeight(nodes.length, height);
	const offset = windowOffset(nodes.length, view, focusOrdinal ?? activeOrdinal);
	const { from, to } = visibleNodeRange(nodes.length, view, offset);
	const shownNode = shown === null ? undefined : nodes[shown];
	const ordinalAt = (clientY: number) => {
		const rect = railRef.current?.getBoundingClientRect();
		return rect ? nodeAt(clientY - rect.top, offset, nodes.length) : -1;
	};

	// 预览：刻度右侧，垂直对准节点；按实际尺寸夹在视口内
	let previewStyle: CSSProperties | undefined;
	if (shown !== null) {
		const rect = railRef.current?.getBoundingClientRect();
		if (rect) {
			const half = previewHeight / 2;
			const width = Math.min(PREVIEW_WIDTH, window.innerWidth - 2 * PREVIEW_EDGE);
			const y = rect.top + offset + nodeY(shown);
			previewStyle = {
				left: Math.max(
					PREVIEW_EDGE,
					Math.min(rect.left + PREVIEW_OFFSET, window.innerWidth - width - PREVIEW_EDGE),
				),
				top: Math.min(window.innerHeight - PREVIEW_EDGE - half, Math.max(PREVIEW_EDGE + half, y)),
				width,
				// 首次测量前不显示，避免从未夹位的位置跳一下
				visibility: previewHeight ? undefined : "hidden",
			};
		}
	}

	return (
		<nav
			ref={navRef}
			aria-label={t("messageRail.ariaLabel")}
			data-message-rail
			className="absolute inset-y-0 z-10 flex flex-col justify-center py-3"
			style={{ left: inset + RAIL_LEFT, width: RAIL_WIDTH }}
		>
			<div
				ref={railRef}
				role="listbox"
				tabIndex={0}
				aria-label={t("messageRail.ariaLabel")}
				aria-activedescendant={focusOrdinal === null ? undefined : `message-rail-${focusOrdinal}`}
				className="relative shrink-0 cursor-pointer overflow-hidden rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
				style={{ height: view }}
				onMouseMove={(event) => setPointer(ordinalAt(event.clientY))}
				onMouseLeave={() => setPointer(null)}
				// 鼠标点击不拿焦点：否则 onFocus 进入键盘选择态，窗口被钉在焦点节点上，不再跟随阅读位置
				onMouseDown={(event) => event.preventDefault()}
				onClick={(event) => {
					const node = nodes[ordinalAt(event.clientY)];
					if (node) onJump(node);
				}}
				onWheel={(event) => onWheel(event.deltaY)}
				onFocus={() => setFocusOrdinal((current) => current ?? Math.max(0, activeOrdinal))}
				onBlur={() => setFocusOrdinal(null)}
				onKeyDown={(event) => {
					const current = focusOrdinal ?? Math.max(0, activeOrdinal);
					const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
					if (step) {
						event.preventDefault();
						setFocusOrdinal(Math.min(nodes.length - 1, Math.max(0, current + step)));
					} else if (event.key === "Home" || event.key === "End") {
						event.preventDefault();
						setFocusOrdinal(event.key === "Home" ? 0 : nodes.length - 1);
					} else if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						const node = nodes[current];
						if (node) onJump(node);
					} else if (event.key === "Escape") {
						railRef.current?.blur();
					}
				}}
			>
				{nodes.slice(from, to).map((node, i) => {
					const ordinal = from + i;
					const active = ordinal === activeOrdinal;
					const pointed = ordinal === (focusOrdinal ?? pointer) && !active;
					// 梯度只由阅读位置决定；指针节点在梯度宽度上至少到第二档并加深（轻量反馈，不改真实高亮）
					const base = tickWidth(ordinal, activeOrdinal);
					const width = pointed ? Math.max(base, RAIL_STYLE.widths[2] ?? base) : base;
					return (
						<div
							key={node.key}
							id={`message-rail-${ordinal}`}
							role="option"
							tabIndex={-1}
							aria-selected={active}
							aria-label={node.excerpt || t("messageRail.jump")}
							data-rail-node={node.key}
							data-active={active || undefined}
							data-unloaded={node.index < 0 || undefined}
							className="pointer-events-none absolute left-0 flex h-2 -translate-y-1/2 items-center"
							style={{ top: offset + nodeY(ordinal) }}
						>
							<span
								data-rail-tick
								className={`rounded-full transition-[width,background-color] duration-200 ease-out ${
									active ? "bg-ink" : pointed ? "bg-ink-dim" : "bg-ink-faint/70"
								}`}
								style={{ width, height: RAIL_STYLE.height }}
							/>
						</div>
					);
				})}
			</div>
			{shownNode &&
				previewStyle &&
				createPortal(
					<div
						ref={previewRef}
						role="tooltip"
						data-rail-preview
						className="pointer-events-none fixed z-50 -translate-y-1/2 rounded-xl border border-border bg-surface px-2.5 pt-3.5 pb-4 shadow-soft"
						style={previewStyle}
					>
						{/* 标题 = 用户提问；摘要 = 本轮助手首段正文（最多三行，没有就只显示标题） */}
						<p data-rail-preview-title className="truncate text-ui-13 font-semibold leading-snug text-ink">
							{shownNode.excerpt}
						</p>
						{shownNode.reply && (
							<p
								data-rail-preview-reply
								className="mt-2.5 line-clamp-3 text-ui-12 leading-[1.75] text-ink-dim"
							>
								{shownNode.reply}
							</p>
						)}
					</div>,
					document.body,
				)}
		</nav>
	);
}
