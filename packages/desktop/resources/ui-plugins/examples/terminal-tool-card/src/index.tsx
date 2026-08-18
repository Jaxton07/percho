import { useT } from "@percho/plugin-api";
import { memo } from "react";

/**
 * 终端风工具卡（随包示例，agent 写插件的起点）：
 * - 只 import react / @percho/plugin-api 两个虚拟模块（其余 npm 包禁止）
 * - memo 包裹（槽位在每条消息的热路径上）
 * - 样式一律语义 token（bg-canvas/text-ink/…），深浅主题自适应
 */
export const ToolCallCard = memo(function ToolCallCard({
	tool,
}: {
	tool: { name: string; args: string; output: string; state: string };
}) {
	const t = useT();
	return (
		<details className="group/dets drawer-details">
			<summary className="group/row flex cursor-pointer items-center gap-2 py-0.5 select-none [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 font-mono text-[13px] font-semibold text-ink transition-colors group-hover/row:text-accent">
					▸ {tool.name.toUpperCase()}
				</span>
				<span className="relative overflow-hidden whitespace-nowrap font-mono text-[12px] text-ink-faint transition-colors group-hover/row:text-ink-2">
					{tool.args.slice(0, 60)}
				</span>
				{tool.state === "running" && (
					<span className="shrink-0 animate-pulse text-[11px] text-accent">{t("message.working")}</span>
				)}
			</summary>
			<div className="flex flex-col gap-1.5 py-1 pl-4">
				<pre className="max-h-40 overflow-x-auto rounded-lg bg-canvas px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink-dim select-text whitespace-pre-wrap">
					{tool.output || tool.args}
				</pre>
			</div>
		</details>
	);
});
