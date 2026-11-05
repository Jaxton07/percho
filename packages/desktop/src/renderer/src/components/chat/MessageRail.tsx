import { memo, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { nearDistance, RAIL_MIN_NODES, type RailNode, sameMarkers } from "./message-rail";

interface Props {
	/** 全历史节点（每条用户消息一个），按对话顺序 */
	nodes: readonly RailNode[];
	/** 视口内的轮次区间（节点序号，含两端）；来自虚拟列表的位置索引，不依赖历史 DOM 是否存在 */
	inView: { from: number; to: number } | null;
	/** 跳转：smooth 用于点击，instant 用于拖动连续定位 */
	onJump: (node: RailNode, behavior: ScrollBehavior) => void;
	/** 左侧被别的浮层占用的宽度（会话轨道） */
	inset: number;
	/** 对话正文列：确认左侧空带够宽 */
	columnRef: RefObject<HTMLElement | null>;
}

/** 正文左侧至少留这么宽才显示（pi-gna: GUTTER = 48） */
const GUTTER = 48;
/** pi-gna: OPEN_DELAY / CLOSE_DELAY */
const OPEN_DELAY = 150;
const CLOSE_DELAY = 120;
const ROW_HEIGHT = 10;
const OVERSCAN = 4;
const FALLBACK_HEIGHT = 640;

/**
 * 对话 Minimap（#110）。交互机制参考 MIT 项目 pi-gna 的 TurnRail（manuelcecchetto/pi-gna）：
 * - 每条用户消息一个 10px 行，轨道垂直居中、最高 min(70vh, 40rem)，超出时列表内部滚动、滚动条隐藏；
 * - 视口内的轮次提亮（可同时多条），轨道自动滚动让它们留在可视范围内；指针在轨道上时不自动滚动；
 * - 悬停：指针下的刻度放大到 26px，相邻三格 0.7/0.4/0.2；卡片 150ms 后出、离开 120ms 后关；
 * - 点击平滑跳转；按住拖动连续定位（instant）；未加载的历史先按需加载再跳（由 onJump 处理）。
 * 阅读高亮（inView）、悬停（hot）、拖动（scrubbing）三个状态互相独立。
 */
export function MessageRail({ nodes, inView, onJump, inset, columnRef }: Props) {
	const t = useT();
	const fits = useGutter(columnRef, inset);
	if (!fits || nodes.length < RAIL_MIN_NODES) return null;
	return (
		<Rail nodes={nodes} inView={inView} onJump={onJump} inset={inset} label={t("messageRail.ariaLabel")} />
	);
}

function Rail({
	nodes,
	inView,
	onJump,
	inset,
	label,
}: {
	nodes: readonly RailNode[];
	inView: { from: number; to: number } | null;
	onJump: (node: RailNode, behavior: ScrollBehavior) => void;
	inset: number;
	label: string;
}) {
	/** 指针下或正在拖动的刻度：放大，卡片显示它那一轮 */
	const [hot, setHot] = useState<number | null>(null);
	const [card, setCard] = useState(false);
	const [scrubbing, setScrubbing] = useState(false);
	const [fade, setFade] = useState("");
	const [viewport, setViewport] = useState({ top: 0, height: FALLBACK_HEIGHT });
	const nav = useRef<HTMLElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const box = useRef<HTMLDivElement>(null);
	const opening = useRef<ReturnType<typeof setTimeout>>(undefined);
	const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
	const scrub = useRef<{ pointerId: number; index: number; moved: boolean; y: number } | null>(null);
	const frame = useRef<number | null>(null);
	/** 拖动结束时会在起点刻度上触发一次 click，那一次不能再跳回去 */
	const dragged = useRef(false);
	const pressedIndex = useRef<number | null>(null);
	const settle = useCallback(() => {
		clearTimeout(opening.current);
		clearTimeout(closing.current);
	}, []);
	useEffect(
		() => () => {
			settle();
			if (frame.current !== null) cancelAnimationFrame(frame.current);
		},
		[settle],
	);
	const updateViewport = useCallback((element: HTMLElement) => {
		const top = element.scrollTop;
		const height = element.clientHeight || FALLBACK_HEIGHT;
		setViewport((old) => (old.top === top && old.height === height ? old : { top, height }));
		setFade(edges(element));
	}, []);
	useLayoutEffect(() => {
		const element = list.current;
		if (!element) return;
		const observer = new ResizeObserver(() => updateViewport(element));
		observer.observe(element);
		updateViewport(element);
		return () => observer.disconnect();
	}, [updateViewport]);

	const hover = (index: number) => {
		settle();
		setHot(index);
		if (!card) opening.current = setTimeout(() => setCard(true), OPEN_DELAY);
	};
	const leave = () => {
		settle();
		closing.current = setTimeout(() => {
			setCard(false);
			setHot(null);
		}, CLOSE_DELAY);
	};
	const indexAt = (target: EventTarget | null): number | undefined => {
		const button = target instanceof Element ? target.closest<HTMLElement>("[data-rail-index]") : null;
		return button && list.current?.contains(button) ? Number(button.dataset.railIndex) : undefined;
	};
	const endScrub = (event: React.PointerEvent) => {
		const state = scrub.current;
		if (state?.pointerId !== event.pointerId) return;
		scrub.current = null;
		if (frame.current !== null) cancelAnimationFrame(frame.current);
		frame.current = null;
		setScrubbing(false);
		dragged.current = state.moved;
		if (event.type !== "pointerup") pressedIndex.current = null;
		setTimeout(() => {
			dragged.current = false;
			pressedIndex.current = null;
		}, 0);
		if (!nav.current?.matches(":hover")) leave();
	};

	// 轨道自身滚动：让视口内的轮次留在可视范围（首条优先），拖动时跟随被拖的刻度；
	// 指针在轨道上时不动，否则轨道会在指针下移动。节点数变化（新一轮）时也要重算位置与渐隐。
	const [from, to] =
		scrubbing && hot !== null ? [hot, hot] : hot === null && inView ? [inView.from, inView.to] : [-1, -1];
	const count = nodes.length;
	useLayoutEffect(() => {
		const element = list.current;
		if (!element || count === 0) return;
		const height = element.clientHeight || FALLBACK_HEIGHT;
		for (const index of [to, from]) {
			if (index < 0 || index >= count) continue;
			const top = index * ROW_HEIGHT;
			if (top < element.scrollTop) element.scrollTop = top;
			else if (top + ROW_HEIGHT > element.scrollTop + height) {
				element.scrollTop = top + ROW_HEIGHT - height;
			}
		}
		updateViewport(element);
	}, [from, to, count, updateViewport]);

	// 卡片在被悬停刻度右侧，垂直对准它，夹在聊天区内
	useLayoutEffect(() => {
		const host = nav.current;
		const element = box.current;
		const rail = list.current;
		if (!host || !element || !rail || hot === null) return;
		const markerTop = rail.getBoundingClientRect().top + hot * ROW_HEIGHT - rail.scrollTop;
		const bounds = (host.offsetParent ?? document.body).getBoundingClientRect();
		const half = element.offsetHeight / 2;
		const center = Math.min(
			Math.max(markerTop + ROW_HEIGHT / 2, bounds.top + 8 + half),
			bounds.bottom - 8 - half,
		);
		element.style.top = `${center - host.getBoundingClientRect().top}px`;
	});

	const hotNode = hot === null ? undefined : nodes[hot];
	const start = Math.max(0, Math.min(count, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN));
	const end = Math.max(
		start,
		Math.min(count, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN),
	);

	const moveScrub = () => {
		const state = scrub.current;
		const element = list.current;
		if (!state || !element) return;
		const rect = element.getBoundingClientRect();
		const direction = state.y < rect.top + ROW_HEIGHT ? -1 : state.y >= rect.bottom - ROW_HEIGHT ? 1 : 0;
		if (direction) element.scrollTop += direction * ROW_HEIGHT;
		updateViewport(element);
		const y = Math.min(Math.max(state.y - rect.top, 0), Math.max(0, element.clientHeight - 1));
		const index = Math.min(count - 1, Math.max(0, Math.floor((element.scrollTop + y) / ROW_HEIGHT)));
		const node = nodes[index];
		if (node && index !== state.index) {
			state.index = index;
			state.moved = true;
			settle();
			setHot(index);
			setCard(true);
			onJump(node, "instant");
		}
		if (
			direction &&
			((direction < 0 && element.scrollTop > 0) ||
				(direction > 0 && element.scrollTop + element.clientHeight < element.scrollHeight))
		) {
			frame.current = requestAnimationFrame(moveScrub);
		} else frame.current = null;
	};
	return (
		<nav
			ref={nav}
			aria-label={label}
			data-message-rail
			className="absolute top-1/2 z-20 -translate-y-1/2"
			style={{ left: inset + 12 }}
			onPointerEnter={() => clearTimeout(closing.current)}
			onPointerLeave={() => {
				if (!scrub.current) leave();
			}}
		>
			{/* 每个刻度的 pointerover / click 都委托到列表：刻度单独渲染（Markers），流式输出时不重绘。
			    键盘用文档级 Alt+↑/↓（见 MessageList），刻度本身不进 Tab 顺序（与 pi-gna 一致）。 */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: 事件委托到子 button，容器本身不可交互 */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: 子 button 自带键盘激活，另有 Alt+↑/↓ */}
			<div
				ref={list}
				className="message-rail-list"
				data-fade={fade || undefined}
				data-scrubbing={scrubbing || undefined}
				onScroll={(event) => updateViewport(event.currentTarget)}
				onClick={(event) => {
					const index = indexAt(event.target) ?? pressedIndex.current;
					pressedIndex.current = null;
					const node = nodes[index ?? -1];
					if (!node || dragged.current) return;
					onJump(node, "smooth");
				}}
				onPointerOver={(event) => {
					if (scrub.current) return;
					const index = indexAt(event.target);
					if (index !== undefined && index !== indexAt(event.relatedTarget)) hover(index);
				}}
				onPointerDown={(event) => {
					const index = indexAt(event.target);
					if (event.button !== 0 || index === undefined) return;
					pressedIndex.current = index;
					scrub.current = { pointerId: event.pointerId, index, moved: false, y: event.clientY };
					event.currentTarget.setPointerCapture(event.pointerId);
					setScrubbing(true);
					setHot(index);
				}}
				onPointerMove={(event) => {
					const state = scrub.current;
					if (state?.pointerId !== event.pointerId) return;
					state.y = event.clientY;
					if (frame.current !== null) cancelAnimationFrame(frame.current);
					frame.current = null;
					moveScrub();
				}}
				onPointerUp={endScrub}
				onPointerCancel={endScrub}
				onLostPointerCapture={endScrub}
			>
				<div aria-hidden style={{ height: start * ROW_HEIGHT, flexShrink: 0 }} />
				<Markers
					nodes={nodes}
					start={start}
					end={end}
					hot={hot}
					from={inView?.from ?? -1}
					to={inView?.to ?? -1}
				/>
				<div aria-hidden style={{ height: (count - end) * ROW_HEIGHT, flexShrink: 0 }} />
			</div>
			{card && hotNode && (
				<div
					ref={box}
					role="tooltip"
					data-rail-preview
					className="message-rail-card pointer-events-none absolute left-full ml-1 w-[320px] max-w-[calc(100vw-1rem)] -translate-y-1/2 rounded-xl border border-border bg-surface p-2.5 text-ui-13 leading-5 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.25)]"
				>
					<RailCard node={hotNode} />
				</div>
			)}
		</nav>
	);
}

/**
 * 每条用户消息一个刻度。流式输出只改最后一轮的摘要（新数组、同样的刻度），这里不重绘（pi-gna: Markers）。
 */
const Markers = memo(
	function Markers({
		nodes,
		start,
		end,
		hot,
		from,
		to,
	}: {
		nodes: readonly RailNode[];
		start: number;
		end: number;
		hot: number | null;
		from: number;
		to: number;
	}) {
		return (
			<>
				{nodes.slice(start, end).map((node, offset) => {
					const index = start + offset;
					return (
						<button
							key={node.key}
							type="button"
							tabIndex={-1}
							data-rail-index={index}
							data-rail-node={node.key}
							data-hot={hot === index || undefined}
							data-unloaded={node.index < 0 || undefined}
							aria-current={index >= from && index <= to ? "true" : undefined}
							aria-label={node.excerpt}
							className="message-rail-item"
						>
							<span className="message-rail-marker" data-near={nearDistance(index, hot)}>
								<span className="message-rail-line" />
							</span>
						</button>
					);
				})}
			</>
		);
	},
	(previous, next) =>
		previous.start === next.start &&
		previous.end === next.end &&
		previous.hot === next.hot &&
		previous.from === next.from &&
		previous.to === next.to &&
		sameMarkers(previous.nodes, next.nodes),
);

/** 用户消息一行（标题），下面是本轮助手回复的前三行（pi-gna / Codex 的卡片结构） */
function RailCard({ node }: { node: RailNode }) {
	return (
		<>
			<div data-rail-preview-title className="truncate font-medium text-ink">
				{node.excerpt}
			</div>
			{node.reply && (
				<p data-rail-preview-reply className="mt-1 line-clamp-3 text-ui-12 leading-[1.6] text-ink-dim">
					{node.reply}
				</p>
			)}
		</>
	);
}

/** 正文列左侧是否给轨道留够了空间（pi-gna: useGutter） */
function useGutter(columnRef: RefObject<HTMLElement | null>, inset: number): boolean {
	const [fits, setFits] = useState(false);
	useLayoutEffect(() => {
		const column = columnRef.current;
		const parent = column?.offsetParent;
		if (!column || !(parent instanceof HTMLElement)) return;
		const measure = () => {
			const left =
				column.getBoundingClientRect().left +
				(Number.parseFloat(getComputedStyle(column).paddingLeft) || 0) -
				parent.getBoundingClientRect().left;
			setFits(left - inset >= GUTTER);
		};
		const observer = new ResizeObserver(measure);
		observer.observe(column);
		observer.observe(parent);
		measure();
		return () => observer.disconnect();
	}, [columnRef, inset]);
	return fits;
}

/** 哪一端因为还有被滚过去的刻度而渐隐 */
function edges(element: HTMLElement): string {
	const top = element.scrollTop > 0;
	const bottom = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
	return [top ? "top" : "", bottom ? "bottom" : ""].filter(Boolean).join(" ");
}
