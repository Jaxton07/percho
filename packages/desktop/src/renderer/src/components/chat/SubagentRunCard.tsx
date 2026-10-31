import { type MessageKey, useT } from "../../i18n";
import { withSessionSlide } from "../../lib/session-page-slide";
import { useSessionsStore } from "../../stores/sessions";
import type { SubagentRunUi } from "../../stores/transcript";

/** 子代理名展示：首字母大写，其余原样（不翻译、不改写） */
function displayName(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/** 单个子代理行：状态点 + 名称与思考档位；有会话文件时可点击打开 */
function SubagentRunRow({ run }: { run: SubagentRunUi }) {
	const t = useT();
	// 走统一入口：它同步捕获父目标并只在「仍是最新导航意图」时记下返回关系（spec D4）
	const openSubagentSession = useSessionsStore((s) => s.openSubagentSession);

	// runner 创建会话文件后即回填 sessionFile；运行中同样允许打开只读检视页。
	const clickable = run.sessionFile != null;
	const statusLabel = t(
		(
			{
				running: "message.subagent.running",
				queued: "message.subagent.queued",
				aborted: "message.subagent.aborted",
				error: "message.subagent.failed",
				done: "message.subagent.done",
			} as const
		)[run.status],
	);

	return (
		<button
			type="button"
			disabled={!clickable}
			// 推入过渡：子代理页从右向左滑入（父页同时向左滑出，见 lib/session-page-slide.ts）
			onClick={() => {
				if (!clickable || !run.sessionFile) return;
				void withSessionSlide("push", () => openSubagentSession(run.sessionFile as string));
			}}
			className={`flex w-full items-center gap-2 py-1 text-left ${
				clickable ? "cursor-pointer rounded-md hover:bg-hover" : "cursor-default"
			} px-1.5 transition-colors`}
		>
			{run.status === "running" ? (
				<span
					role="img"
					aria-label={statusLabel}
					className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
				/>
			) : run.status === "error" ? (
				<span role="img" aria-label={statusLabel} className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
			) : run.status === "aborted" || run.status === "queued" ? (
				<span
					role="img"
					aria-label={statusLabel}
					className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint"
				/>
			) : (
				<span
					role="img"
					aria-label={statusLabel}
					className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500"
				/>
			)}
			<span className="truncate text-ui-13 font-semibold text-ink">
				{displayName(run.agent)}
				{run.index != null ? ` #${run.index}` : ""}
			</span>
			{run.thinkingLevel && (
				<span className="shrink-0 text-ui-11 text-ink-faint">
					{t(`thinkingLevels.${run.thinkingLevel}` as MessageKey)}
				</span>
			)}
		</button>
	);
}

/** subagent 独立行：子代理调用结果（工作中/完成/失败 + 点击打开子会话），不进工具折叠区 */
export function SubagentRunCard({ runs }: { runs: SubagentRunUi[] }) {
	return (
		<div className="mt-1">
			{runs.map((run) => (
				<SubagentRunRow key={run.key} run={run} />
			))}
		</div>
	);
}
