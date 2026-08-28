import type { SummarySegment } from "@percho/shared";
import { useT } from "../../i18n";
import { displayName } from "./ToolCallCard";

/** en 复数单位（zh 模板不含 {unit} 占位，参数传入即被忽略） */
const pluralUnit = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** 汇总段文案：已知类目走 i18n 模板；other 显示 原名 ×N（无需翻译） */
export function summaryLabel(t: ReturnType<typeof useT>, seg: SummarySegment): string {
	switch (seg.category) {
		case "read":
			return t("message.summaryRead", { n: seg.count, unit: pluralUnit(seg.count, "file", "files") });
		case "edit":
			return t("message.summaryEdit", { n: seg.count, unit: pluralUnit(seg.count, "file", "files") });
		case "explore":
			return t("message.summaryExplore", { n: seg.count, unit: pluralUnit(seg.count, "time", "times") });
		case "search":
			return t("message.summarySearch", { n: seg.count, unit: pluralUnit(seg.count, "time", "times") });
		case "bash":
			return t("message.summaryBash", { n: seg.count, unit: pluralUnit(seg.count, "command", "commands") });
		case "subagent":
			return t("message.summarySubagents", {
				n: seg.count,
				unit: pluralUnit(seg.count, "subagent", "subagents"),
			});
		default:
			return `${displayName(seg.name)} ×${seg.count}`;
	}
}
