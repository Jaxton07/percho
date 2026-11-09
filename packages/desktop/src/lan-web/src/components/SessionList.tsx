import type { LanSessionBrief } from "@percho/shared";
import { useCallback, useEffect, useRef, useState } from "react";
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
	const token = useLanStore((s) => s.token);
	const [cursor, setCursor] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const generation = useRef(0);
	const loadPage = useCallback(
		async (next?: string) => {
			const current = ++generation.current;
			setLoading(true);
			try {
				const params = new URLSearchParams({ t: token });
				if (next) params.set("cursor", next);
				const response = await fetch(`/api/sessions?${params}`, { cache: "no-store" });
				if (!response.ok) throw new Error("catalog unavailable");
				const page = (await response.json()) as { list: LanSessionBrief[]; nextCursor?: string };
				if (generation.current !== current) return;
				useLanStore.setState((state) => ({
					list: next
						? [
								...state.list,
								...page.list.filter((item) => !state.list.some((old) => old.sessionId === item.sessionId)),
							]
						: page.list,
				}));
				setCursor(page.nextCursor);
				setError(false);
			} catch {
				if (generation.current === current) setError(true);
			} finally {
				if (generation.current === current) setLoading(false);
			}
		},
		[token],
	);
	useEffect(() => {
		setCursor(undefined);
		void loadPage();
		return () => {
			generation.current++;
		};
	}, [loadPage]);
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
			{list.length === 0 && <div className="empty">{t("list.empty")}</div>}
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
			{(cursor || error) && (
				<button type="button" disabled={loading} onClick={() => void loadPage(error ? undefined : cursor)}>
					{error
						? navigator.language.startsWith("zh")
							? "刷新列表"
							: "Refresh list"
						: navigator.language.startsWith("zh")
							? "加载更多"
							: "Load more"}
				</button>
			)}
		</div>
	);
}
