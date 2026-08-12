import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import type { SubagentRunUi } from "../../stores/transcript";

/** 子代理名展示：首字母大写，其余原样（不翻译、不改写） */
function displayName(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/** 单个子代理行：状态点（工作中呼吸动画 / 完成勾 / 失败红点）+ 加粗名称 + 状态；有会话文件时可点击打开 */
function SubagentRunRow({ run }: { run: SubagentRunUi }) {
	const t = useT();
	const openFromHistory = useSessionsStore((s) => s.openFromHistory);

	const clickable = run.sessionFile != null && run.status !== "running";
	const statusLabel =
		run.status === "running"
			? t("message.subagent.running")
			: run.status === "error"
				? t("message.subagent.failed")
				: t("message.subagent.done");

	return (
		<button
			type="button"
			disabled={!clickable}
			onClick={() => clickable && run.sessionFile && void openFromHistory(run.sessionFile)}
			className={`flex w-full items-center gap-2 py-1 text-left ${
				clickable ? "cursor-pointer rounded-md hover:bg-hover" : "cursor-default"
			} px-1.5 transition-colors`}
		>
			{run.status === "running" ? (
				<span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
			) : run.status === "error" ? (
				<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
			) : (
				<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
			)}
			<span className="truncate text-[13px] font-semibold text-ink">{displayName(run.agent)}</span>
			<span className="shrink-0 text-[11px] text-ink-faint">{statusLabel}</span>
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
