import type { UIToolCall } from "../../stores/transcript";
import { Markdown } from "./Markdown";
import { MetaGroup, type MetaItem } from "./MetaGroup";

/** 助手消息体：元数据（思考/工具，折叠）+ Markdown 正文 + 打字指示器 */
export function AssistantMessage({
	text,
	thinking,
	tools,
	streaming,
}: {
	text: string;
	thinking: string;
	tools: UIToolCall[];
	streaming?: boolean;
}) {
	const items: MetaItem[] = [];
	if (thinking || tools.length > 0) items.push({ thinking, tools, streaming });

	return (
		<div className="flex flex-col gap-2">
			{items.length > 0 && <MetaGroup items={items} />}
			{text && <Markdown text={text} />}
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
