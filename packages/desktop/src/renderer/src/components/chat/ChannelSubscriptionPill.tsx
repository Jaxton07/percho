import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ChannelIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";
import type { ChannelPillPresence } from "./channel-pill-presence";

/**
 * 频道订阅胶囊（spec D2 的展示层，无状态）。
 *
 * 视觉基线 = `.local/design/ux/channel-subscription-pill/index.html`：
 * 无边框 `surface + shadow-pop`、`rounded-full`、13px 频道 glyph（ink-faint）、12px 文字（ink-dim）、
 * 多个频道在**一个胶囊**里以间隔点分隔、名称原样不翻译。
 *
 * 动画：宽度 0 ↔ **实测自然宽度**，右缘固定（左端向左伸展）；退场宽度回 0 并淡出，**DOM 保留到收起结束**
 * （状态机保证 `display` 还在）。`translateX` 一律不参与 —— 平移不能冒充展开。
 *
 * 与外部约定的三件事：
 * 1. `opened` 由状态机给；本组件只负责把宽度/透明度过渡过去，并在收起结束时回调 `onExitFinished(token)`；
 * 2. 收起结束有两条路（`transitionend` 快速路径 + 定时器兜底），两条都带令牌 ⇒ 旧 timer 删不掉新胶囊；
 * 3. reduced-motion：CSS 关过渡（`.channel-pill`），这里把兜底时长按 0 处理 ⇒ 立即清理。
 */
export const CHANNEL_PILL_DURATION_MS = 360; // 与 styles/globals.css 的 --channel-pill-time 同步

export function ChannelSubscriptionPill({
	presence,
	onExitFinished,
}: {
	presence: ChannelPillPresence;
	onExitFinished: (token: number) => void;
}) {
	const observerRef = useRef<ResizeObserver | null>(null);
	const [naturalWidth, setNaturalWidth] = useState(0);
	/** 目标宽度：展开态 = 实测自然宽度；收起态 / 刚挂载 = 0（挂载当帧必须先是 0，下一帧再放到自然宽度才有过渡） */
	const [targetWidth, setTargetWidth] = useState(0);

	/**
	 * 实测内容自然宽度：**用 ref 回调**（内容节点挂载/卸载时 React 自己会调用），挂载即测 + ResizeObserver
	 * 跟内容/字号/窗口变化。不用 effect：本组件在没内容时也会挂载（返回 null），那时拿不到内容节点，
	 * `useLayoutEffect(..., [])` 会永远量不到宽度（阶段 4 实测踩到：宽度卡在 0 不展开）。
	 */
	const measureRef = useCallback((el: HTMLDivElement | null) => {
		observerRef.current?.disconnect();
		observerRef.current = null;
		if (!el) return;
		const measure = () => setNaturalWidth(el.getBoundingClientRect().width);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		observerRef.current = observer;
	}, []);

	// 展开：先留一帧 0 宽度，再放到自然宽度（同一个提交内改完不会有过渡）
	useEffect(() => {
		if (!presence.opened || naturalWidth === 0) return;
		const raf = requestAnimationFrame(() => setTargetWidth(naturalWidth));
		return () => cancelAnimationFrame(raf);
	}, [presence.opened, naturalWidth]);

	// 收起 / 卸载：立刻把目标设回 0（宽度过渡开始）
	useEffect(() => {
		if (!presence.opened) setTargetWidth(0);
	}, [presence.opened]);

	// 收起结束的兜底定时器（transitionend 可能因为元素被复用到别处/时长 0 而不来）
	useEffect(() => {
		if (presence.opened || !presence.mounted) return;
		const token = presence.token;
		const reduce =
			typeof window !== "undefined" &&
			window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
		const timer = setTimeout(() => onExitFinished(token), reduce ? 0 : CHANNEL_PILL_DURATION_MS + 80);
		return () => clearTimeout(timer);
	}, [presence.opened, presence.mounted, presence.token, onExitFinished]);

	if (!presence.mounted) return null;

	const label = presence.display.join(" · ");
	return (
		<Tooltip label={label} align="end" className="pointer-events-auto">
			<span
				className={`channel-pill rounded-full bg-surface shadow-pop${presence.opened ? " channel-pill-open" : ""}`}
				style={{ width: targetWidth }}
				aria-hidden={!presence.opened}
				onTransitionEnd={(event) => {
					if (event.propertyName === "width" && !presence.opened) onExitFinished(presence.token);
				}}
			>
				<div ref={measureRef} className="flex w-max items-center gap-2 px-3 py-[7px] text-ui-12 text-ink-dim">
					<ChannelIcon className="shrink-0 text-ink-faint" />
					<span className="max-w-[300px] truncate">
						{presence.display.map((topic, index) => (
							<Fragment key={topic}>
								{index > 0 && <span className="px-1.5 text-ink-faint">·</span>}
								{topic}
							</Fragment>
						))}
					</span>
				</div>
			</span>
		</Tooltip>
	);
}
