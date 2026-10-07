import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { THINKING_BAR_KNOB, thinkingLevelKey, thinkingLevelPos } from "../../lib/thinking";
import { useSessionsStore } from "../../stores/sessions";

/** 指针位移超过它才当「拖拽」（像素）：低于它算点击，点击要留动画 */
const DRAG_THRESHOLD_PX = 3;

/**
 * 思考深度横条（模型弹层底部，设计稿 .local/design/ux/model-thinking-picker）：
 * - 26px 胶囊轨道 + 蓝紫渐变填充 + 每档一枚 5px 刻度 + 26px 白滑块（原生 range）；
 * - 刻度中心 x = 填充宽 = 滑块中心，三者共用 lib/thinking.ts 的 thinkingLevelPos；
 * - 换档位（点轨道 / 键盘 / 换模型后收敛）时滑块与填充一起走 280ms 位移/展开动画；
 *   **只有真拖拽才关动画**（位移过 DRAG_THRESHOLD_PX）——按住不放不算拖拽，否则点轨道就看不到动画了；
 * - 滑块是自绘的（原生 thumb 透明化，只留拖拽与键盘能力）——原生 thumb 没法加位移动画；
 * - 只有一档（非推理模型只给 off）时不给可拖的把手：不渲染 input、不画填充，只剩一枚淡刻度；
 * - 条下不放任何文字说明（档位名在标题行右侧）。
 */
export function ThinkingSlider({ level, supported }: { level: string; supported: readonly string[] }) {
	const t = useT();
	const setThinkingLevel = useSessionsStore((s) => s.setThinkingLevel);
	const [pressing, setPressing] = useState(false);
	const [dragging, setDragging] = useState(false);
	const originX = useRef<number | null>(null);

	const index = Math.max(supported.indexOf(level), 0);
	const count = supported.length;
	// 非推理模型（SDK 只给 off）：没有可调的档位
	const locked = count <= 1;
	const pos = (i: number) =>
		`calc((100% - ${THINKING_BAR_KNOB}px) * ${thinkingLevelPos(i, count)} + ${THINKING_BAR_KNOB / 2}px)`;
	/**
	 * 填充宽度：铺到**滑块中心**（clip-path 裁出来的是方角，刚好切在滑块圆的最宽处，被滑块盖住）。
	 * 最低档要特判成 0：滑块中心在 13px（半个滑块）处，不特判会留下 13px 宽的填充，
	 * 它的圆角左帽露在滑块圆外（滑块只盖 x∈[0,26] 的圆内区域）→ 看着像滑块左半边有道渐变描边（实际踩过）。
	 * 注意别想着「右端补成与滑块同心的半圆」：border-radius 打在整条宽度的元素上，
	 * 被 clip-path 裁开后右端仍是方角，补 +26 只会让方块露到滑块右边。
	 */
	const fillWidth = index === 0 ? "0px" : pos(index);

	// 指针可能在轨道外抬起（原生 range 有指针捕获，但别指望它）：窗口上兜一层
	useEffect(() => {
		if (!pressing) return;
		const release = () => {
			setPressing(false);
			setDragging(false);
			originX.current = null;
		};
		window.addEventListener("pointerup", release);
		window.addEventListener("pointercancel", release);
		return () => {
			window.removeEventListener("pointerup", release);
			window.removeEventListener("pointercancel", release);
		};
	}, [pressing]);

	return (
		<div className={`flex flex-col gap-[7px] px-2 pt-1 pb-2 ${locked ? "opacity-70" : ""}`}>
			<div className="flex items-baseline justify-between px-0.5">
				<span className="text-ui-11 text-ink-faint">{t("composer.thinkingDepth")}</span>
				<span className="text-ui-13 font-medium text-ink-2">{t(thinkingLevelKey(level))}</span>
			</div>
			<div className="think-slider" data-dragging={dragging ? "true" : "false"}>
				<div className="think-track" />
				{!locked && <div className="think-fill" style={{ "--fillw": fillWidth } as CSSProperties} />}
				{supported.map((item, i) => (
					<span
						// 档位名即唯一键（supported 已去重且顺序规范化）
						key={item}
						className="think-tick"
						data-passed={!locked && i <= index ? "true" : "false"}
						style={{ left: pos(i) }}
					/>
				))}
				{!locked && (
					<>
						<input
							type="range"
							className="think-range"
							min={0}
							max={count - 1}
							step={1}
							value={index}
							aria-label={t("composer.thinkingDepth")}
							aria-valuetext={t(thinkingLevelKey(level))}
							onPointerDown={(e) => {
								setPressing(true);
								originX.current = e.clientX;
							}}
							onPointerMove={(e) => {
								if (originX.current === null || dragging) return;
								if (Math.abs(e.clientX - originX.current) > DRAG_THRESHOLD_PX) setDragging(true);
							}}
							onChange={(e) => void setThinkingLevel(supported[Number(e.target.value)] as string)}
						/>
						{/* 自绘滑块：rail 从轨道左端缩进 13px、宽 = 轨道 - 26px，整体按 --pos(0..1) 平移 100%×自身宽 */}
						<div
							className="think-knob-rail"
							style={{ "--pos": thinkingLevelPos(index, count) } as CSSProperties}
						>
							<div className="think-knob" />
						</div>
					</>
				)}
			</div>
		</div>
	);
}
