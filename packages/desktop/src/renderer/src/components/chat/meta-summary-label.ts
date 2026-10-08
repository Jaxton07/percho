import type { SummarySegment } from "@percho/shared";
import type { useT } from "../../i18n";
import { displayName } from "./tool-label";

/** en 复数单位（zh 模板不含 {unit} 占位，参数传入即被忽略） */
const pluralUnit = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** 汇总段文案：已知类目走 i18n 模板；**MCP 段按 server 归并**（`blender ×3`，工具名留展开明细）；
 *  other 的内置工具名走翻译，第三方工具保留原名 */
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
		case "mcp":
			// 服务器名原样呈现（不走 displayName：server 名可能与内置工具同名，会被翻译串味）
			return `${seg.server ?? seg.name} ×${seg.count}`;
		case "subagent":
			return t("message.summarySubagents", {
				n: seg.count,
				unit: pluralUnit(seg.count, "subagent", "subagents"),
			});
		default:
			return `${displayName(seg.name, t)} ×${seg.count}`;
	}
}
