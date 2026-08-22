import { t } from "../i18n";
import { useLanStore } from "../store";

/** 底部状态条：连接态 / 工作中·工具名 / compacting / tokens 用量 */
export function StatusBar({ sessionId }: { sessionId: string | null }) {
	const status = useLanStore((s) => s.status);
	const view = useLanStore((s) => (sessionId ? s.views[sessionId] : undefined));
	const connLabel =
		status === "connected"
			? t("conn.connected")
			: status === "reconnecting"
				? t("conn.reconnecting")
				: t("conn.connecting");
	const parts: string[] = [];
	if (view?.agentActive)
		parts.push(view.currentTool ? `${t("status.working")} · ${view.currentTool}` : t("status.working"));
	if (view?.compacting) parts.push(t("status.compacting"));
	if (view?.queued) parts.push(t("status.queued"));
	if (view?.stats) {
		parts.push(`↑${view.stats.inputTokens} ↓${view.stats.outputTokens}`);
	}
	return (
		<div className="statusbar">
			<span className={`conn-dot ${status === "connected" ? "ok" : "bad"}`} />
			<span>{connLabel}</span>
			{parts.length > 0 && <span className="working-label">· {parts.join(" · ")}</span>}
		</div>
	);
}
