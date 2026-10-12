import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { useSubagentReturnStore } from "../../stores/subagent-return";
import { ArrowLeftIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";

/**
 * 子代理检视页的「返回父会话」入口（spec D4）：当前会话有已知父关系时才出现，否则渲染 null。
 *
 * 形态：**仅一枚 ghost 图标**（14px 箭头，hover 才现底色），无常驻文案、无胶囊 —— 文案只在
 * Tooltip（悬停出现）与 `aria-label`（无障碍名）里存在。
 * 尺寸：固定 `h-7 w-7 shrink-0` + `self-start`，不因同容器里更宽的插件贡献被 flex 拉伸。
 * Tooltip 用 `align="start"`：入口贴在聊天区左缘，居中锚点的气泡会向左溢出撑出幻影横向滚动条。
 *
 * 关系是独立叶子 store（`stores/subagent-return.ts`）里的状态，所以「打开子会话 → 关系写入」
 * 会自然触发本次重渲染，不需要额外的手动刷新。
 */
export function SubagentBackButton() {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const returnToParent = useSessionsStore((s) => s.returnToParent);
	const hasParent = useSubagentReturnStore((s) =>
		activeSessionId ? Boolean(s.relations[activeSessionId]) : false,
	);
	if (!activeSessionId || !hasParent) return null;

	return (
		<Tooltip label={t("message.subagent.backToParent")} align="start" className="self-start">
			<button
				type="button"
				aria-label={t("message.subagent.backToParent")}
				onClick={() => void returnToParent(activeSessionId)}
				className="pointer-events-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-hover hover:text-ink"
			>
				<ArrowLeftIcon size={14} />
			</button>
		</Tooltip>
	);
}
