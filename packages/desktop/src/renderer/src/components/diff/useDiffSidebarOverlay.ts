import { useEffect, useState } from "react";
import { useUiPreferencesStore } from "../../stores/ui-preferences";

/** 右栏 push 的宽度规则（与 `.diff-sidebar` 的 CSS 一致）：min(420px, 38vw) */
function diffSidebarWidth(viewport: number): number {
	return Math.min(420, viewport * 0.38);
}

/** 聊天列保底宽（画板 C 的宽度账本：中间列 `min-w-[380px]`） */
const MIN_CHAT_WIDTH = 380;

/**
 * 右栏该用 push 还是浮层（窗口宽度账本，画板 C）：
 *   可用宽（视口 − 左栏实际占宽）≥ 380 + min(420, 38vw) → push；
 *   否则 push 会把聊天列压破 380 保底 → 右栏转浮层叠在聊天列上（不参与布局宽度）。
 * 只在「值真的变了」时 setState（resize 每帧都会触发，直接 setState 会让整棵树白渲染）。
 * 临界点约 1000px（左栏展开时：1000 − 240 = 760 = 380 + 380）。
 */
export function useDiffSidebarOverlay(): boolean {
	const collapsed = useUiPreferencesStore((s) => s.sidebarCollapsed);
	const [overlay, setOverlay] = useState(() => compute(collapsed));

	useEffect(() => {
		const computeNow = () => setOverlay(compute(useUiPreferencesStore.getState().sidebarCollapsed));
		computeNow(); // 左栏开合也会改变可用宽：收起/展开必须重算
		// resize 期间每帧只算一次（rAF 合帧），不额外 debounce：计算是常数级，setState 已按值去抖
		let frame = 0;
		const onResize = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(computeNow);
		};
		window.addEventListener("resize", onResize);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("resize", onResize);
		};
	}, [collapsed]);

	return overlay;
}

function compute(sidebarCollapsed: boolean): boolean {
	const viewport = window.innerWidth;
	const available = viewport - (sidebarCollapsed ? 0 : 240);
	return available < MIN_CHAT_WIDTH + diffSidebarWidth(viewport);
}
