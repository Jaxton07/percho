import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { ActivityEntry, UIToolCall } from "../../stores/transcript";
import { ExpandArrowIcon } from "../icons";
import { type LivePreviewItem, PreviewTicker } from "./PreviewTicker";
import { ToolCallCard } from "./ToolCallCard";

/** 折叠组中的一条元数据项（一条消息的思考/工具，或流式中的进行中部分） */
export interface MetaItem {
	thinking: string;
	tools: UIToolCall[];
	/** 流式项的活动序列（到达顺序），预览行数据源；仅流式（未提交）项携带 */
	activity?: ActivityEntry[];
}

/** 思考过程行（内层折叠，与 tool call 行同风格） */
function ThinkingRow({ thinking }: { thinking: string }) {
	const t = useT();
	return (
		<details className="group/dets">
			<summary className="group/row flex cursor-pointer items-center gap-2 py-0.5 select-none [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 text-[13px] font-semibold text-ink-faint transition-colors group-hover/row:text-ink">
					{t("message.thinking")}
				</span>
				<ExpandArrowIcon className="shrink-0 text-ink-faint opacity-0 transition-[opacity,transform,color] group-hover/row:opacity-100 group-hover/row:text-ink-2 group-open/dets:rotate-90" />
			</summary>
			<div className="py-1 pl-4 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-dim select-text">
				{thinking}
			</div>
		</details>
	);
}
/** working → worked 切换的缓冲时长：turn 间隙内不闪烁 */
const HYSTERESIS_MS = 1500;

/**
 * 外层折叠组：聚合多条非正文消息的思考/工具，标题 = Working/Worked + 项目数
 * endByText：组被正文边界切分（streaming.text 在输出）→ working 信号消失时立即结束，
 * 不做滞后缓冲；否则（turn 间隙）滞后 HYSTERESIS_MS 防闪烁
 */
export function MetaGroup({
	items,
	working,
	endByText = false,
}: {
	items: MetaItem[];
	working: boolean;
	endByText?: boolean;
}) {
	const t = useT();
	const count = items.reduce((n, item) => n + (item.thinking ? 1 : 0) + item.tools.length, 0);

	// 滞后缓冲：working 信号消失后需保持 HYSTERESIS_MS 才显示 worked（turn 间隙内不闪烁）
	const [shownWorking, setShownWorking] = useState(working);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		if (working) {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			setShownWorking(true);
		} else if (shownWorking) {
			if (endByText) {
				// 正文已出现：组立即结束，避免与正文后的新预览重叠
				setShownWorking(false);
				return;
			}
			if (!timerRef.current) {
				timerRef.current = setTimeout(() => {
					timerRef.current = null;
					setShownWorking(false);
				}, HYSTERESIS_MS);
			}
		}
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [working, shownWorking, endByText]);

	const rows = items.flatMap((item, i) => [
		// biome-ignore lint/suspicious/noArrayIndexKey: 折叠组内项无独立 id，列表顺序稳定
		item.thinking ? <ThinkingRow key={`thinking-${i}`} thinking={item.thinking} /> : null,
		...item.tools.map((tool) => <ToolCallCard key={tool.key} tool={tool} />),
	]);
	// 实时预览：流式项的活动序列按到达顺序展开（latest-wins，预览行显示最后一条）
	const liveItems = useMemo<LivePreviewItem[]>(() => {
		const out: LivePreviewItem[] = [];
		for (const item of items) {
			if (!item.activity) continue;
			for (const entry of item.activity) {
				out.push(
					entry.kind === "thinking"
						? { kind: "thinking", id: entry.id }
						: { kind: "tool", id: entry.id, name: entry.name ?? "tool", args: entry.args ?? "" },
				);
			}
		}
		return out;
	}, [items]);

	/** 单条已结束（如正文前的思考）直接裸行展示，不套 "已完成 · 1" 外壳 */
	const showWrapper = count >= 2 || shownWorking;
	if (!showWrapper) {
		return <div className="flex flex-col gap-1.5">{rows}</div>;
	}

	return (
		// -mb-3：抵消 MessageList gap-6 的一部分，状态行与后续正文/消息间距收紧
		<div className="-mb-3">
			<details className="group/outer peer">
				<summary className="group/row flex cursor-pointer items-center gap-2 py-0.5 select-none [&::-webkit-details-marker]:hidden">
					<span
						className={`shrink-0 text-[13px] font-bold transition-colors ${
							shownWorking ? "shimmer-sweep text-ink-dim" : "text-ink-dim group-hover/row:text-ink"
						}`}
					>
						{t(shownWorking ? "message.working" : "message.worked")}
						{count > 0 && <span className="ml-1 font-normal text-ink-faint">· {count}</span>}
					</span>
					<ExpandArrowIcon className="shrink-0 text-ink-faint opacity-0 transition-[opacity,transform,color] group-hover/row:opacity-100 group-hover/row:text-ink-2 group-open/outer:rotate-90" />
				</summary>
				<div className="flex flex-col gap-1.5 py-1">{rows}</div>
			</details>
			<div className="peer-[[open]]:hidden">
				{shownWorking && <PreviewTicker items={liveItems} reserveSpace />}
			</div>
		</div>
	);
}
