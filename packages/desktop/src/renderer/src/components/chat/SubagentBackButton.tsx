import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { useSubagentReturnStore } from "../../stores/subagent-return";
import { ArrowLeftIcon } from "../icons";

/**
 * 子代理检视页的「返回父会话」入口（spec D4）：当前会话有已知父关系时才出现，否则渲染 null。
 *
 * 关系是独立叶子 store（`stores/subagent-return.ts`）里的状态，所以「打开子会话 → 关系写入」
 * 会自然触发本次重渲染，不需要额外的手动刷新。
 *
 * 位置：交给 `RegionHost(chat.corner.top-left)` 的 `leading` 插槽 —— 与插件区域贡献共用同一个
 * 左上定位容器（顺序 = [返回入口, 各贡献]），避免与合规的左上贡献重叠。
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
		<button
			type="button"
			onClick={() => void returnToParent(activeSessionId)}
			aria-label={t("message.subagent.backToParent")}
			title={t("message.subagent.backToParent")}
			className="pointer-events-auto flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
		>
			<ArrowLeftIcon size={13} />
			<span className="text-ui-115">{t("message.subagent.backToParent")}</span>
		</button>
	);
}
