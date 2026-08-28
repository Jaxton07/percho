import { type ReactNode, useState } from "react";
import { useT } from "../../i18n";
import type { UIMessage } from "../../stores/transcript";

/** 上下文压缩分割线：──── 状态文字 ────（codex/opencode 式）；done 态摘要可点击展开 */
export function SystemMessage({ message }: { message: Extract<UIMessage, { kind: "system" }> }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const compact = message.compact;
	if (!compact) {
		const mutex = message.mutex;
		if (mutex) {
			const fileName = mutex.extensionPath.split(/[\\/]/).pop() ?? mutex.extensionPath;
			return (
				<CompactionDivider>
					{t("message.subagent.mutex", { path: fileName, tools: mutex.tools.join(", ") })}
				</CompactionDivider>
			);
		}
		return <CompactionDivider>{message.text}</CompactionDivider>;
	}
	const reason = t(`compaction.reason.${compact.reason}`);

	if (compact.status === "running") {
		return (
			<CompactionDivider>
				<span className="h-3 w-3 animate-spin rounded-full border-2 border-border-strong border-t-ink-dim" />
				<span>
					{t("compaction.running")} · {reason}
				</span>
			</CompactionDivider>
		);
	}
	if (compact.status === "cancelled") {
		return (
			<CompactionDivider>
				{t("compaction.cancelled")} · {reason}
			</CompactionDivider>
		);
	}
	if (compact.status === "error") {
		// 提醒级信息（多为无可压缩内容等非致命原因），琥珀色而非错误红
		return (
			<CompactionDivider className="text-amber-500">
				{t("compaction.failed", { error: compact.errorMessage ?? "" })}
			</CompactionDivider>
		);
	}
	const tokens =
		compact.tokensBefore != null && compact.tokensAfter != null
			? ` · ${formatTokens(compact.tokensBefore)} → ${formatTokens(compact.tokensAfter)}`
			: "";
	return (
		<div>
			<CompactionDivider>
				<span>
					{t("compaction.done")} · {reason}
					{tokens}
				</span>
				{compact.summary && (
					<button
						type="button"
						className="transition-colors hover:text-ink-2"
						onClick={() => setExpanded((v) => !v)}
					>
						{t("compaction.summary")} {expanded ? "▴" : "▾"}
					</button>
				)}
			</CompactionDivider>
			{expanded && compact.summary && (
				<p className="mx-auto max-w-[560px] px-3 pb-1 text-center text-xs leading-relaxed break-words text-ink-dim select-text">
					{compact.summary}
				</p>
			)}
		</div>
	);
}

function CompactionDivider({
	children,
	className = "text-ink-faint",
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={`flex items-center gap-3 py-1 text-xs select-none ${className}`}>
			<span className="h-px flex-1 bg-border" />
			<span className="flex items-center gap-2">{children}</span>
			<span className="h-px flex-1 bg-border" />
		</div>
	);
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}
