import type { SubagentRunUi } from "@percho/shared";
import { t } from "../i18n";

/** 子代理卡（props 版移植；lan-web 不打开子会话 —— 历史会话本就只读列表）。
 *  UX v2：白卡+柔影容器，行间 0.5px hairline，状态文案右对齐着色（run 紫 / ok 绿 / bad 红）。 */
export function SubagentCard({ runs }: { runs: SubagentRunUi[] }) {
	return (
		<div className="agent-box">
			{runs.map((run) => {
				const state = run.status === "running" ? "run" : run.status === "error" ? "bad" : "ok";
				const statusLabel =
					run.status === "running"
						? t("subagent.running")
						: run.status === "error"
							? t("subagent.failed")
							: t("subagent.done");
				return (
					<div key={run.key} className="agent-row">
						<span className={`pulse-dot sm ${state === "run" ? "violet" : state === "bad" ? "bad" : ""}`} />
						<span className="agent-name">{run.agent.charAt(0).toUpperCase() + run.agent.slice(1)}</span>
						{run.task && <span className="agent-task">{run.task}</span>}
						<span className={`agent-state ${state}`}>{statusLabel}</span>
					</div>
				);
			})}
		</div>
	);
}
