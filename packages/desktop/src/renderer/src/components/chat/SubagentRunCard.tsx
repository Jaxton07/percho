import { useT } from "../../i18n";
import { withSessionSlide } from "../../lib/session-page-slide";
import { useSessionsStore } from "../../stores/sessions";
import type { SubagentRunUi } from "../../stores/transcript";

const STATUS_KEYS = {
	running: "message.subagent.running",
	queued: "message.subagent.queued",
	done: "message.subagent.done",
	error: "message.subagent.failed",
	aborted: "message.subagent.aborted",
} as const;

/** 单个子代理行：Worker 编号 + 工作态打字点 / 终态圆点；有会话文件时可点击打开 */
function SubagentRunRow({ run, index }: { run: SubagentRunUi; index: number }) {
	const t = useT();
	// 走统一入口：它同步捕获父目标并只在「仍是最新导航意图」时记下返回关系（spec D4）
	const openSubagentSession = useSessionsStore((s) => s.openSubagentSession);

	// runner 创建会话文件后即回填 sessionFile；运行中同样允许打开只读检视页。
	const clickable = run.sessionFile != null;
	const statusLabel = t(STATUS_KEYS[run.status]);
	const label = `${t("message.subagent.worker")} ${index}`;

	return (
		<button
			type="button"
			disabled={!clickable}
			// 推入过渡：子代理页从右向左滑入（父页同时向左滑出，见 lib/session-page-slide.ts）
			onClick={() => {
				if (!clickable || !run.sessionFile) return;
				void withSessionSlide("push", () => openSubagentSession(run.sessionFile as string));
			}}
			className={`flex w-fit items-center gap-2.5 py-1 text-left ${
				clickable ? "cursor-pointer rounded-md hover:bg-hover" : "cursor-default"
			} px-1.5 transition-colors`}
		>
			<span className="truncate text-ui-13 font-semibold text-ink">{label}</span>
			<span className="subagent-slot">
				<span
					className="subagent-cap"
					data-state={run.status}
					role="img"
					aria-label={statusLabel}
					title={`${label} · ${statusLabel}`}
				>
					<span className="subagent-dots" aria-hidden="true">
						<i />
						<i />
						<i />
					</span>
				</span>
			</span>
		</button>
	);
}

/** subagent 独立行：子代理调用结果（工作中/完成/失败 + 点击打开子会话），不进工具折叠区 */
export function SubagentRunCard({ runs }: { runs: SubagentRunUi[] }) {
	return (
		<div className="mt-1">
			{runs.map((run, i) => (
				<SubagentRunRow key={run.key} run={run} index={i + 1} />
			))}
		</div>
	);
}
