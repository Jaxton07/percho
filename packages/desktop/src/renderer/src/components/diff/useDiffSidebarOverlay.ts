import { useEffect, useState } from "react";
import { useUiPreferencesStore } from "../../stores/ui-preferences";

/** 右栏 push 的宽度规则（与 `.diff-sidebar` 的 CSS 一致）：min(420px, 38vw) */
function diffSidebarWidth(viewport: number): number {
	return Math.min(420, viewport * 0.38);
}

/** 聊天列保底宽（画板 C 的宽度账本：中间列 `min-w-[380px]`） */
const MIN_CHAT_WIDTH = 380;
/** 左侧栏展开时的占宽（与 `.sidebar` CSS 一致） */
const SIDEBAR_WIDTH = 240;

/**
 * 右栏该用 push 还是浮层（窗口宽度账本，画板 C）：
 *   可用宽（视口 − 左栏实际占宽）≥ 380 + min(420, 38vw) → push；
 *   否则 push 会把聊天列压破 380 保底 → 右栏转浮层叠在聊天列上（不参与布局宽度）。
 * 临界点约 1000px（左栏展开时：1000 − 240 = 760 = 380 + 380）。
 *
 * 单一数据源：viewport 进 state、渲染期直接算（不在 effect 里比较后写 state）；
 * resize 用 rAF 合帧（一次拖窗每帧只算一次），state 相同值不会触发重渲染，所以不必额外 debounce。
 */
export function useDiffSidebarOverlay(): boolean {
	const collapsed = useUiPreferencesStore((s) => s.sidebarCollapsed);
	const [viewport, setViewport] = useState(() => window.innerWidth);

	useEffect(() => {
		let frame = 0;
		const onResize = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => setViewport(window.innerWidth));
		};
		window.addEventListener("resize", onResize);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("resize", onResize);
		};
	}, []);

	const available = viewport - (collapsed ? 0 : SIDEBAR_WIDTH);
	return available < MIN_CHAT_WIDTH + diffSidebarWidth(viewport);
}
