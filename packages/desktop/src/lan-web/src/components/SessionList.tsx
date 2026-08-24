import { t } from "../i18n";
import { useLanStore } from "../store";
import { ChevronRightIcon, ShieldIcon } from "./icons";

/** 会话列表页：所有会话可点进聊天页（活跃会话走快照种子；历史会话按需拉 transcript，
 *  输入区在会话未打开/只读时显示提示）。
 *  UX v2：分区 label（正在运行/历史·只读）+ 去边框卡（左 3px 状态竖条：工作中=紫渐变流动，
 *  空闲=绿 55%，历史=透明底+hairline）+ chip 徽章行。 */
export function SessionList() {
	const list = useLanStore((s) => s.list);
	const views = useLanStore((s) => s.views);
	const perms = useLanStore((s) => s.pendingPerms);
	const select = useLanStore((s) => s.select);

	if (list.length === 0) {
		return <div className="empty">{t("list.empty")}</div>;
	}
	const sorted = [...list].sort((a, b) => Number(b.active) - Number(a.active) || b.modifiedAt - a.modifiedAt);
	const activeItems = sorted.filter((item) => views[item.sessionId]);
	const historyItems = sorted.filter((item) => !views[item.sessionId]);

	const renderCard = (item: (typeof sorted)[number]) => {
		const view = views[item.sessionId];
		const pendingPerm = (perms[item.sessionId]?.length ?? 0) > 0 || Boolean(view?.pendingPermission);
		const state = view ? (view.agentActive ? "live" : "idle") : "history";
		return (
			<button
				key={item.sessionId}
				type="button"
				className={`s-card ${state}`}
				onClick={() => select(item.sessionId)}
			>
				{state !== "history" && <span className="rail" />}
				<div className="s-row1">
					<span className={`pulse-dot${state === "live" ? " violet" : " still"}`} />
					<span className="s-name">{item.name}</span>
					<ChevronRightIcon size={16} className="s-chevron" />
				</div>
				<div className="s-cwd">{item.cwd}</div>
				<div className="s-badges">
					{view ? (
						<>
							<span className={`chip${view.agentActive ? " live" : " idle"}`}>
								<span className="mini-dot" />
								{view.agentActive ? t("status.working") : t("status.idle")}
							</span>
							{view.compacting && <span className="chip">{t("status.compacting")}</span>}
							{pendingPerm && (
								<span className="chip perm">
									<ShieldIcon size={11} />
									{t("perm.title")}
								</span>
							)}
						</>
					) : (
						<span className="chip">{t("list.readonly")}</span>
					)}
				</div>
			</button>
		);
	};

	return (
		<div className="list-scroll">
			{activeItems.length > 0 && (
				<>
					<div className="section-label">
						{t("list.sectionActive")}
						<span className="n">· {activeItems.length}</span>
					</div>
					{activeItems.map(renderCard)}
				</>
			)}
			{historyItems.length > 0 && (
				<>
					<div className="section-label">
						{t("list.sectionHistory")}
						<span className="n">· {historyItems.length}</span>
					</div>
					{historyItems.map(renderCard)}
				</>
			)}
		</div>
	);
}
