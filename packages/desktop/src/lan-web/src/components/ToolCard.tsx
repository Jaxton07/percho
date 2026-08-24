import type { UIToolCall } from "@percho/shared";
import { ChevronRightIcon } from "./icons";

/** 与桌面端 ToolCallCard.summarizeArgs 同逻辑：优先 command/filePath/url 字段，容忍流式不完整 JSON */
export function summarizeArgs(args: string): string {
	if (!args || args === "{}") return "";
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		const command = parsed.command ?? parsed.cmd;
		if (typeof command === "string") return command;
		const filePath = parsed.filePath ?? parsed.path ?? parsed.file;
		if (typeof filePath === "string") return filePath;
		const url = parsed.url;
		if (typeof url === "string") return url;
	} catch {
		for (const key of ["command", "cmd", "filePath", "path", "file", "url"]) {
			const value = args.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))?.[1];
			if (value) return value;
		}
	}
	const trimmed = args.slice(0, 120);
	return trimmed.length < args.length ? `${trimmed}…` : trimmed;
}

const displayName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** 工具调用卡（桌面 ToolCallCard 的纯 CSS 移植版）：默认折叠，折叠态 = 名 + 参数摘要单行截断 */
export function ToolCard({ tool }: { tool: UIToolCall }) {
	const summary = summarizeArgs(tool.args);
	return (
		<div className="tool-row">
			<details className="drawer-details">
				<summary className="tool-summary">
					<span
						className={`tool-state-dot${tool.state === "running" ? " running" : tool.state === "error" ? " error" : ""}`}
					/>
					<span className={`tool-name${tool.state === "running" ? " running" : ""}`}>
						{displayName(tool.name)}
					</span>
					{summary && <span className="tool-args-summary">{summary}</span>}
					<ChevronRightIcon size={12} className="tool-arrow" />
				</summary>
				<div className="tool-detail">
					{tool.args && <pre>{tool.args}</pre>}
					{tool.output && <pre>{tool.output}</pre>}
				</div>
			</details>
		</div>
	);
}
