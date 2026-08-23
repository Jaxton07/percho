import {
	type ActivityEntry,
	dotsFromItems,
	type MetaDot,
	type MetaItem,
	type SummarySegment,
	summarizeCategories,
} from "@percho/shared";
import { useMemo } from "react";
import { t } from "../i18n";
import { ChevronRightIcon } from "./icons";
import { TailMarquee } from "./TailMarquee";
import { ToolCard } from "./ToolCard";
import { useShownWorking } from "./use-shown-working";

/** 汇总段文案（lan-web 迷你字典；other 段显示 原名 ×N） */
function summaryLabel(seg: SummarySegment): string {
	switch (seg.category) {
		case "read":
			return t("meta.read", { n: seg.count });
		case "edit":
			return t("meta.edit", { n: seg.count });
		case "explore":
			return t("meta.explore", { n: seg.count });
		case "search":
			return t("meta.search", { n: seg.count });
		case "bash":
			return t("meta.bash", { n: seg.count });
		case "subagent":
			return t("meta.subagents", { n: seg.count });
		default:
			return `${seg.name} ×${seg.count}`;
	}
}

/** 最新一条活动的预览文本（working 期滚动行数据源） */
function latestActivityText(items: MetaItem[]): string {
	const latest = latestActivity(items);
	if (!latest) return "";
	return latest.kind === "thinking" ? latest.text : `${latest.name} ${latest.args}`;
}

/** 最新一条活动条目 */
function latestActivity(items: MetaItem[]): ActivityEntry | undefined {
	for (let i = items.length - 1; i >= 0; i--) {
		const activity = items[i]?.activity;
		if (activity && activity.length > 0) return activity[activity.length - 1];
	}
	return undefined;
}

/** 思考过程行（内层折叠） */
function ThinkingRow({ thinking }: { thinking: string }) {
	return (
		<details className="drawer-details meta-thinking">
			<summary>
				{t("meta.thinking")}
				<ChevronRightIcon size={12} className="meta-caret" />
			</summary>
			<div className="meta-thinking-body">{thinking}</div>
		</details>
	);
}

/**
 * 折叠组（与桌面 MetaGroup 同一语义，渲染壳为移动端重写）：
 * 标题行 working 期 = 呼吸点 + Working/思考中 + 贴尾滚动预览；worked 期 = 圆点串 + 分类统计
 * （读取/编辑/探索/搜索/执行命令/子代理 ×N）。展开区为完整思考行/工具卡。
 * 单条已结束项直接裸行展示（不套外壳）；流式/子代理锚点始终成组。
 */
export function MetaGroup({
	items,
	working,
	endImmediately,
	subagentCount,
	isDark: _isDark,
}: {
	items: MetaItem[];
	working: boolean;
	endImmediately: boolean;
	subagentCount: number;
	isDark: boolean;
}) {
	const count = items.reduce((n, item) => n + (item.thinking ? 1 : 0) + item.tools.length, 0);
	const dots = useMemo(() => dotsFromItems(items), [items]);
	const segments = useMemo(() => summarizeCategories(items, subagentCount), [items, subagentCount]);
	const shownWorking = useShownWorking(working, endImmediately);
	const preview = useMemo(() => latestActivityText(items), [items]);
	const isThinking = useMemo(() => latestActivity(items)?.kind !== "tool", [items]);

	const rows = items.flatMap((item, i) => [
		// biome-ignore lint/suspicious/noArrayIndexKey: 折叠组内项无独立 id，列表顺序稳定
		item.thinking ? <ThinkingRow key={`thinking-${i}`} thinking={item.thinking} /> : null,
		...item.tools.map((tool) => <ToolCard key={tool.key} tool={tool} />),
	]);

	const showWrapper = count >= 2 || shownWorking || subagentCount > 0;
	if (!showWrapper) {
		return <div className="meta-bare">{rows}</div>;
	}

	return (
		<details className="meta-group drawer-details">
			<summary className="meta-head">
				{shownWorking ? (
					<>
						<span className="wave">
							<i />
							<i />
							<i />
						</span>
						<span className="meta-live-label">
							{isThinking ? t("meta.thinkingLabel") : t("meta.working")}
						</span>
						{preview && <TailMarquee text={preview} />}
					</>
				) : (
					<>
						<span className="meta-dots">
							{dots.map((dot: MetaDot) => (
								<i
									key={dot.key}
									className={dot.state === "error" ? "err" : dot.state === "running" ? "run" : ""}
								/>
							))}
						</span>
						<span className="meta-sum">
							{segments.length > 0 ? segments.map(summaryLabel).join(" · ") : t("meta.worked")}
						</span>
					</>
				)}
				<ChevronRightIcon size={13} className="meta-caret" />
			</summary>
			<div className="meta-body">{rows}</div>
		</details>
	);
}
