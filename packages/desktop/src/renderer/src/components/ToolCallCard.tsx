import { useT } from "../i18n";
import type { UIToolCall } from "../stores/transcript";

const toolIcons: Record<string, string> = {
	bash: ">_",
	read: "📄",
	write: "✏️",
	edit: "🖊",
	grep: "🔍",
	find: "🔎",
	ls: "📁",
};

function summarizeArgs(args: string): string {
	if (!args || args === "{}") return "";
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		const command = parsed.command ?? parsed.cmd;
		if (typeof command === "string") return command;
		const filePath = parsed.filePath ?? parsed.path ?? parsed.file;
		if (typeof filePath === "string") return filePath;
	} catch {
		// 非 JSON，原样展示
	}
	const trimmed = args.slice(0, 120);
	return trimmed.length < args.length ? `${trimmed}…` : trimmed;
}

/** 工具调用折叠卡片 */
export function ToolCallCard({ tool }: { tool: UIToolCall }) {
	const t = useT();
	const summary = summarizeArgs(tool.args);
	const stateColor =
		tool.state === "error"
			? "border-red-200 bg-red-50"
			: tool.state === "done"
				? "border-zinc-200"
				: "border-zinc-200 bg-zinc-50";
	const dotColor =
		tool.state === "running"
			? "bg-violet-500 animate-pulse"
			: tool.state === "error"
				? "bg-red-500"
				: "bg-zinc-400";

	return (
		<details
			className={`rounded-lg border ${stateColor}`}
			open={tool.state === "running" || tool.output.length > 0}
		>
			<summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 select-none">
				<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
				<span className="font-mono text-[12px] font-medium text-zinc-700">
					{toolIcons[tool.name] ?? "🔧"} {tool.name}
				</span>
				{summary && <span className="truncate font-mono text-[11px] text-zinc-500">{summary}</span>}
				{tool.state === "running" && (
					<span className="ml-auto text-[10px] text-zinc-400">{t("tool.running")}</span>
				)}
			</summary>
			{tool.output && (
				<div className="border-t border-zinc-100 px-2.5 py-2">
					<pre className="max-h-56 overflow-y-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-zinc-600 select-text">
						{tool.output}
					</pre>
				</div>
			)}
			{tool.args && !summary && (
				<div className="border-t border-zinc-100 px-2.5 py-2">
					<pre className="font-mono text-[11.5px] whitespace-pre-wrap text-zinc-500 select-text">
						{tool.args}
					</pre>
				</div>
			)}
		</details>
	);
}
