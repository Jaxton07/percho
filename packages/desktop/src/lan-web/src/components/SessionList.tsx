import { t } from "../i18n";
import { useLanStore } from "../store";

/** 会话列表页：活跃会话可点进聊天页，历史会话置灰只读（M1 不提供历史 transcript 浏览）。 */
export function SessionList() {
	const list = useLanStore((s) => s.list);
	const views = useLanStore((s) => s.views);
	const perms = useLanStore((s) => s.pendingPerms);
	const select = useLanStore((s) => s.select);

	if (list.length === 0) {
		return <div className="empty">{t("list.empty")}</div>;
	}
	const sorted = [...list].sort((a, b) => Number(b.active) - Number(a.active) || b.modifiedAt - a.modifiedAt);
	return (
		<div className="session-list">
			{sorted.map((item) => {
				const view = views[item.sessionId];
				const active = Boolean(view);
				const pendingPerm = (perms[item.sessionId]?.length ?? 0) > 0 || Boolean(view?.pendingPermission);
				return (
					<button
						key={item.sessionId}
						type="button"
						className={`session-row${active ? "" : " history"}`}
						disabled={!active}
						onClick={() => active && select(item.sessionId)}
					>
						<div className="session-name">
							<span className={`dot${view?.agentActive ? " live" : ""}`} />
							{item.name}
						</div>
						<div className="session-cwd">{item.cwd}</div>
						{active && (
							<div className="session-badges">
								<span className={`badge${view?.agentActive ? " live" : ""}`}>
									{view?.agentActive ? t("status.working") : t("status.idle")}
								</span>
								{view?.compacting && <span className="badge">{t("status.compacting")}</span>}
								{pendingPerm && <span className="badge perm">{t("perm.title")}</span>}
							</div>
						)}
					</button>
				);
			})}
		</div>
	);
}
