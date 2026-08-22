import type { SubagentRunUi } from "@percho/shared";
import { t } from "../i18n";

/** 子代理卡（props 版移植；lan-web 不打开子会话 —— 历史会话本就只读列表） */
export function SubagentCard({ runs }: { runs: SubagentRunUi[] }) {
	return (
		<div className="subagent-rows">
			{runs.map((run) => {
				const statusLabel =
					run.status === "running"
						? t("subagent.running")
						: run.status === "error"
							? t("subagent.failed")
							: t("subagent.done");
				return (
					<div key={run.key} className="subagent-row">
						<span className={`dot ${run.status}`} />
						<span className="subagent-name">{run.agent.charAt(0).toUpperCase() + run.agent.slice(1)}</span>
						<span className="subagent-status">{statusLabel}</span>
						{run.task && <span className="subagent-task">{run.task}</span>}
					</div>
				);
			})}
		</div>
	);
}
