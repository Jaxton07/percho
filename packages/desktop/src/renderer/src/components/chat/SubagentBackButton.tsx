import { useLayoutEffect, useRef } from "react";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { useSubagentReturnStore } from "../../stores/subagent-return";
import { ArrowLeftIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";
import { backButtonOffset } from "./subagent-back-offset";

/**
 * 子代理检视页的「返回父会话」入口（spec D4）：当前会话有已知父关系时才出现，否则渲染 null。
 *
 * 形态：**仅一枚 ghost 图标**（21px 箭头，hover 才现底色），无常驻文案、无胶囊 —— 文案只在
 * Tooltip（悬停出现）与 `aria-label`（无障碍名）里存在。
 * 尺寸：固定 `h-[42px] w-[42px] shrink-0` + `self-start`，不因同容器里更宽的插件贡献被 flex 拉伸。
 * Tooltip 用 `align="start"`：气泡左对齐向右伸展，不向左溢出。
 *
 * 水平位置：**聊天区左缘与对话区（气泡左缘）之间那条空带的正中**（算式在 `subagent-back-offset`，
 * 那里解释了为什么不能用 CSS）；用 `useLayoutEffect` + ResizeObserver 写在自身 `transform` 上
 * （挂载即定位，不闪一下），聊天区变宽/变窄（左栏开合、窗口缩放）会重算，空带不够宽时自动退回
 * 「贴左缘 16px」的基线位置。竖直方向仍贴在聊天区左上角。
 *
 * 关系是独立叶子 store（`stores/subagent-return.ts`）里的状态，所以「打开子会话 → 关系写入」
 * 会自然触发本次重渲染，不需要额外的手动刷新。
 */
export function SubagentBackButton() {
	const t = useT();
	const ref = useRef<HTMLButtonElement>(null);
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const returnToParent = useSessionsStore((s) => s.returnToParent);
	const hasParent = useSubagentReturnStore((s) =>
		activeSessionId ? Boolean(s.relations[activeSessionId]) : false,
	);
	const show = Boolean(activeSessionId && hasParent);

	// 注意：hook 必须在提前 return 之前（有关系的会话才渲染，所以用 show 作依赖）
	useLayoutEffect(() => {
		if (!show) return;
		const el = ref.current;
		const main = el?.closest("main");
		const column = main?.querySelector("[data-chat-column]");
		const offsetParent = el?.offsetParent;
		if (!(el instanceof HTMLElement)) return;
		if (!(main instanceof HTMLElement) || !(column instanceof HTMLElement)) return;
		if (!(offsetParent instanceof HTMLElement)) return;
		const apply = () => {
			const offset = backButtonOffset({
				mainLeft: main.getBoundingClientRect().left,
				// 未偏移左缘：offsetParent + offsetLeft 是布局值，不受本元素 transform 影响（反复调用不会漂移）
				naturalLeft: offsetParent.getBoundingClientRect().left + el.offsetLeft,
				columnLeft: column.getBoundingClientRect().left,
				columnPaddingLeft: Number.parseFloat(getComputedStyle(column).paddingLeft) || 0,
				buttonWidth: el.offsetWidth,
			});
			// 只在变化时写：ResizeObserver 回调里反复写同值也会触发样式重算
			const next = offset > 0 ? `translateX(${offset}px)` : "";
			if (el.style.transform !== next) el.style.transform = next;
		};
		apply();
		// 空带宽度只随「聊天区宽度」「对话区列宽（<760 时随聊天区）」「入口宽度」变，观察前两者即可
		const observer = new ResizeObserver(apply);
		observer.observe(main);
		observer.observe(column);
		return () => {
			observer.disconnect();
			el.style.transform = "";
		};
	}, [show]);

	// 用原始条件（而非 show）提前返回，才能把 activeSessionId 收窄成 string
	if (!activeSessionId || !hasParent) return null;

	return (
		<Tooltip label={t("message.subagent.backToParent")} align="start" className="self-start">
			<button
				ref={ref}
				type="button"
				aria-label={t("message.subagent.backToParent")}
				onClick={() => void returnToParent(activeSessionId)}
				className="pointer-events-auto flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl text-ink-faint transition-colors hover:bg-hover hover:text-ink"
			>
				<ArrowLeftIcon size={21} />
			</button>
		</Tooltip>
	);
}
