import { useT } from "../../i18n";
import type { UIToolCall } from "../../stores/transcript";
import { ExpandArrowIcon } from "../icons";
import { ToolCallCard } from "./ToolCallCard";

/** 折叠组中的一条元数据项（一条消息的思考/工具，或流式中的进行中部分） */
export interface MetaItem {
	thinking: string;
	tools: UIToolCall[];
	/** 该项仍在流式（思考或工具进行中） */
	streaming?: boolean;
}

/** 思考过程行（内层折叠，与 tool call 行同风格） */
function ThinkingRow({ thinking }: { thinking: string }) {
	const t = useT();
	return (
		<details className="group/dets">
			<summary className="group/row flex cursor-pointer items-center gap-2 px-1 py-0.5 select-none [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 text-[13px] text-zinc-400 transition-colors group-hover/row:text-zinc-800">
					{t("message.thinking")}
				</span>
				<ExpandArrowIcon className="shrink-0 text-zinc-400 opacity-0 transition-[opacity,transform,color] group-hover/row:opacity-100 group-hover/row:text-zinc-700 group-open/dets:rotate-90" />
			</summary>
			<div className="py-1 pl-4 text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-500 select-text">
				{thinking}
			</div>
		</details>
	);
}

/** 外层折叠组：聚合多条非正文消息的思考/工具，标题 = Working/Worked + 项目数 */
export function MetaGroup({ items }: { items: MetaItem[] }) {
	const t = useT();
	const working = items.some(
		(item) => item.tools.some((tool) => tool.state === "running") || (item.streaming && !!item.thinking),
	);
	const count = items.reduce((n, item) => n + (item.thinking ? 1 : 0) + item.tools.length, 0);

	return (
		<details className="group/outer">
			<summary className="group/row flex cursor-pointer items-center gap-2 px-1 py-0.5 select-none [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 text-[13px] font-medium text-zinc-500 transition-colors group-hover/row:text-zinc-800">
					{t(working ? "message.working" : "message.worked")}
					{working && "…"}
					<span className="ml-1 font-normal text-zinc-400">· {count}</span>
				</span>
				<ExpandArrowIcon className="shrink-0 text-zinc-400 transition-[opacity,transform,color] group-hover/row:text-zinc-700 group-open/outer:rotate-90" />
			</summary>
			<div className="flex flex-col gap-1.5 py-1 pl-4">
				{items.flatMap((item, i) => [
					// biome-ignore lint/suspicious/noArrayIndexKey: 折叠组内项无独立 id，列表顺序稳定
					item.thinking ? <ThinkingRow key={`thinking-${i}`} thinking={item.thinking} /> : null,
					...item.tools.map((tool) => <ToolCallCard key={tool.id} tool={tool} />),
				])}
			</div>
		</details>
	);
}
