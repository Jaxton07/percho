import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/** 光带宽（px，恒定）：高光形状/宽度不随扫光并集伸缩（codex 式固定宽度高光条） */
const BAND_PX = 260;
/** 扫光速度（px/s，恒定）：周期随行程自然伸缩；并集增删只影响回绕阈值，不改写光带几何 */
const SWEEP_SPEED = 160;

/**
 * 扫光渐变（元素相对坐标）：光带位置直接烘焙进 px 色标，背景图恒铺满元素（渐变无固有尺寸）
 * → 底色永远全覆盖、文字永不消失；光带形状保持固定 260px 不随元素宽度拉伸。
 * 不能用「固定 px 图 + background-position」：no-repeat 时光带图不在元素内，文字区域无背景可
 * 裁剪（text-fill 透明 → 整段消失）；repeat 平铺则光带每 260px 重复出现。
 * 光带形状与 globals.css 的 .shimmer-sweep 一致（改则两边同步）。
 */
function bandGradient(centerRel: number): string {
	const s = centerRel - BAND_PX / 2;
	const stop = (f: number) => `${s + f * BAND_PX}px`;
	return `linear-gradient(90deg, currentColor ${stop(0)}, color-mix(in srgb, currentColor 75%, var(--shimmer-highlight)) ${stop(0.28)}, color-mix(in srgb, currentColor 30%, var(--shimmer-highlight)) ${stop(0.46)}, color-mix(in srgb, var(--shimmer-highlight) 90%, currentColor) ${stop(0.5)}, color-mix(in srgb, currentColor 30%, var(--shimmer-highlight)) ${stop(0.54)}, color-mix(in srgb, currentColor 75%, var(--shimmer-highlight)) ${stop(0.72)}, currentColor ${stop(1)})`;
}

/** 清除 rAF 扫光写在元素上的内联背景/填充样式（恢复常规文字颜色） */
function clearSweepStyles(els: (HTMLElement | null)[]) {
	for (const el of els) {
		if (!el) continue;
		el.style.backgroundImage = "";
		el.style.backgroundSize = "";
		el.style.backgroundPosition = "";
		el.style.backgroundRepeat = "";
		el.style.backgroundClip = "";
		el.style.removeProperty("-webkit-background-clip");
		el.style.removeProperty("-webkit-text-fill-color");
	}
}

/**
 * 统一扫光引擎：状态标签（labelRef）与预览行工具名（wrapRef 内 [data-shimmer-name]）
 * 共享同一条光带（固定图宽 + 恒定速度，视口绝对坐标）。
 * 光带几何不依赖并集宽度：工具名挂载/卸载/变长只影响回绕阈值（hi = 并集右缘 + 一整条光带），
 * 光带位置连续无瞬移；回绕两端各留一整条光带的行程，回绕时光带两侧都完全不可见 → 无缝。
 * 元素常态样式由 .sweep-target 兜底（实心 clip，视觉 = 普通文字），扫光每帧只重写 backgroundImage
 *（光带位置烘焙在渐变 px 色标里）→ 挂载与清理无闪帧。
 * 纯 CSS 方案不可行：祖先 background-clip:text 会被 ticker 的 mask/transform 打断（子元素文字不渲染），
 * 各自 shimmer-sweep 则是两条相位/宽度独立的光带。
 *
 * targetsKey：扫光目标集合标识（如预览行 id 串）——集合变化时同一帧补扫光样式，新挂载行在首次
 * paint 前即接上光带，否则有 ≤1 帧的实色空窗。
 */
export function useSweepHighlight(
	enabled: boolean,
	targetsKey: string,
): { labelRef: RefObject<HTMLSpanElement | null>; wrapRef: RefObject<HTMLDivElement | null> } {
	const labelRef = useRef<HTMLSpanElement>(null);
	const wrapRef = useRef<HTMLDivElement>(null);
	/** 供 layout effect 在扫光目标集合变化的同一帧补扫光样式（paint 前执行，消除新行首帧实色闪烁） */
	const paintRef = useRef<() => void>(() => {});

	useEffect(() => {
		if (!enabled) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const label = labelRef.current;
		if (!label) return;
		// 光带中心（视口绝对 x）；NaN = 首帧初始化：放在并集左界外（光带完全不可见处）起步
		let centerAbs = Number.NaN;
		const paint = () => {
			// 切换动画期间新旧两行并存：全部纳入（同 x 位置堆叠，新行立即有扫光）
			const nameEls = Array.from(wrapRef.current?.querySelectorAll<HTMLElement>("[data-shimmer-name]") ?? []);
			const targets: HTMLElement[] = [label, ...nameEls];
			const pairs = targets.map((el) => ({ el, rect: el.getBoundingClientRect() }));
			const visible = pairs.filter((p) => p.rect.width > 0);
			if (visible.length === 0) return;
			const left = Math.min(...visible.map((p) => p.rect.left));
			const right = Math.max(...visible.map((p) => p.rect.right));
			if (Number.isNaN(centerAbs)) centerAbs = left - BAND_PX;
			// 光带完全扫出右界（中心越过右缘 + 一整条光带）→ 回绕到左界外，两端皆不可见
			const lo = left - BAND_PX;
			const hi = right + BAND_PX;
			if (centerAbs > hi) {
				centerAbs = lo + ((centerAbs - lo) % (hi - lo));
			}
			for (const { el, rect } of pairs) {
				if (rect.width === 0) continue;
				el.style.backgroundImage = bandGradient(centerAbs - rect.left);
			}
		};
		paintRef.current = paint;
		let raf = 0;
		let last = performance.now();
		const tick = (now: number) => {
			// 切后台回来 dt 可能很大：钳制，避免光带瞬移（装饰动画，相位漂移无妨）
			const dt = Math.min(now - last, 100);
			last = now;
			centerAbs += SWEEP_SPEED * (dt / 1000);
			paint();
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(raf);
			paintRef.current = () => {};
			clearSweepStyles([
				labelRef.current,
				...Array.from(wrapRef.current?.querySelectorAll<HTMLElement>("[data-shimmer-name]") ?? []),
			]);
		};
	}, [enabled]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: targetsKey 代表扫光目标集合变化；paintRef 由上方扫光 effect 维护
	useLayoutEffect(() => {
		if (enabled) paintRef.current();
	}, [targetsKey, enabled]);

	// Working → Worked 切换：布局阶段同步清除标签上的扫光内联样式（paint 前）。
	// 被动 effect 的 cleanup 跑在 paint 后，若只等它：sweep-target 类已移除（clip 失效）而内联
	// 渐变还在 → 会有一帧未裁剪的渐变底色块闪在 Worked 文字背后
	useLayoutEffect(() => {
		if (!enabled) clearSweepStyles([labelRef.current]);
	}, [enabled]);

	return { labelRef, wrapRef };
}
