import type { UIToolCall } from "../../stores/transcript";
import { Markdown } from "./Markdown";
import { MetaGroup, type MetaItem } from "./MetaGroup";

/** 助手消息体：元数据（思考/工具，折叠）+ Markdown 正文 + 打字指示器 */
export function AssistantMessage({
	text,
	thinking,
	tools,
	streaming,
	metaInGroup = false,
}: {
	text: string;
	thinking: string;
	tools: UIToolCall[];
	streaming?: boolean;
	/** 思考/工具已并入上方合并组（MessageList 合并模式），不再自行包裹 */
	metaInGroup?: boolean;
}) {
	const items: MetaItem[] = [];
	if (!metaInGroup && (thinking || tools.length > 0)) items.push({ thinking, tools });

	return (
		<div className="flex flex-col gap-2">
			{items.length > 0 && <MetaGroup items={items} working={Boolean(streaming) && !text} />}
			{text && <Markdown text={text} streaming={streaming} />}
			{streaming && !text && !thinking && tools.length === 0 && (
				<div className="flex items-center gap-1 text-zinc-400">
					<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400" />
					<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400 [animation-delay:150ms]" />
					<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400 [animation-delay:300ms]" />
				</div>
			)}
		</div>
	);
}
