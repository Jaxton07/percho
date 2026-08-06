import { useT } from "../../i18n";
import type { UIToolCall } from "../../stores/transcript";
import { Markdown } from "./Markdown";
import { ToolCallCard } from "./ToolCallCard";

/** 助手消息体：思考过程（折叠）+ 工具调用 + Markdown 正文 + 打字指示器 */
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
	const t = useT();
	return (
		<div className="flex flex-col gap-2">
			{thinking && (
				<details className="group rounded-lg border border-zinc-100 bg-zinc-50/80">
					<summary className="cursor-pointer px-2.5 py-1 text-xs text-zinc-400 select-none hover:text-zinc-600">
						{t("message.thinking")}
						{streaming && "…"}
					</summary>
					<div className="border-t border-zinc-100 px-2.5 py-2 text-[12.5px] leading-relaxed text-zinc-500 whitespace-pre-wrap select-text">
						{thinking}
					</div>
				</details>
			)}
			{tools.length > 0 && (
				<div className="flex flex-col gap-1.5">
					{tools.map((tool, i) => (
						<ToolCallCard key={`${tool.id || i}`} tool={tool} />
					))}
				</div>
			)}
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
