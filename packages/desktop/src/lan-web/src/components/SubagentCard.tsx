import type { SubagentRunUi } from "@percho/shared";
import { t } from "../i18n";

/** 子代理卡（props 版移植；lan-web 不打开子会话 —— 历史会话本就只读列表）。
 *  UX v2：白卡+柔影容器，行间 0.5px hairline，状态以圆点着色表达。 */
export function SubagentCard({ runs }: { runs: SubagentRunUi[] }) {
	return (
		<div className="agent-box">
			{runs.map((run) => {
				const state = ({ running: "run", queued: "", aborted: "", error: "bad", done: "ok" } as const)[
					run.status
				];
				const statusLabel = t(
					(
						{
							running: "subagent.running",
							queued: "subagent.queued",
							aborted: "subagent.aborted",
							error: "subagent.failed",
							done: "subagent.done",
						} as const
					)[run.status],
				);
				return (
					<div key={run.key} className="agent-row">
						<span
							role="img"
							aria-label={statusLabel}
							className={`pulse-dot sm ${state === "run" ? "violet" : state === "bad" ? "bad" : ""}`}
						/>
						<span className="agent-name">
							{run.agent.charAt(0).toUpperCase() + run.agent.slice(1)}
							{run.index != null ? ` #${run.index}` : ""}
						</span>
						{run.task && <span className="agent-task">{run.task}</span>}
					</div>
				);
			})}
		</div>
	);
}
