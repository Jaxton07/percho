import {
	environmentKey,
	type SessionCatalogPage,
	type SessionCatalogProjects,
	type SessionCatalogSort,
	type SessionMeta,
} from "@percho/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getExecutionApi } from "../../environment-api";
import { useEnvironment } from "../../environment-context";
import { useT } from "../../i18n";
import { initDailyDir } from "../../lib/daily";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { ArchiveIcon, FilterIcon, TrashIcon } from "../icons";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Select } from "../ui/Select";
import { Tooltip } from "../ui/Tooltip";

const sorts: SessionCatalogSort[] = ["archived", "modified", "created", "name"];

/** This panel never opens a session; all requests belong to its selected environment and query. */
export function ArchivedChatsPanel() {
	const t = useT();
	const environment = useEnvironment();
	const status = useRemoteConnectionStore((s) => s.status);
	const online =
		environment.kind === "local" ||
		(status.state === "connected" &&
			!!status.environment &&
			environmentKey(status.environment) === environmentKey(environment));
	const [search, setSearch] = useState("");
	const [cwd, setCwd] = useState("");
	const [sort, setSort] = useState<SessionCatalogSort>("archived");
	const [daily, setDaily] = useState<string | null>(null);
	const [projects, setProjects] = useState<SessionCatalogProjects>();
	const [page, setPage] = useState<SessionCatalogPage>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const [operationError, setOperationError] = useState(false);
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState<SessionMeta | null>(null);
	const generation = useRef(0);
	const envKey = environmentKey(environment);
	const [scope, setScope] = useState(envKey);
	if (scope !== envKey) {
		setScope(envKey);
		setCwd("");
		setDaily(null);
		setProjects(undefined);
		setDeleting(null);
		setBusy(false);
		setError(false);
		setOperationError(false);
	}
	const scopedCwd = scope === envKey ? cwd : "";
	const queryKey = JSON.stringify([envKey, search, scopedCwd, sort]);
	const latestKey = useRef(queryKey);
	latestKey.current = queryKey;
	const pageKey = useRef("");
	const pageScope = useRef("");
	const latestEnv = useRef(envKey);
	latestEnv.current = envKey;
	const api = getExecutionApi(environment);

	const load = useCallback(
		async (append = false, expectedKey = queryKey) => {
			if (!online || expectedKey !== latestKey.current) return;
			const previous = pageKey.current === queryKey ? page : undefined;
			if (append && (!previous?.nextCursor || loading)) return;
			const token = ++generation.current;
			const valid = () => token === generation.current && latestKey.current === queryKey;
			setLoading(true);
			setError(false);
			const query = {
				archived: true,
				...(scopedCwd ? { cwd: scopedCwd } : {}),
				...(search.trim() ? { search: search.trim() } : {}),
				sort,
				limit: 20,
			};
			try {
				let result: SessionCatalogPage;
				let combine = append;
				try {
					result = await api.querySessionCatalog({
						query: append ? { ...query, cursor: previous?.nextCursor } : query,
					});
				} catch (cause) {
					if (!valid()) return;
					if (!append || !/stale/i.test(String(cause))) throw cause;
					combine = false;
					result = await api.querySessionCatalog({ query });
				}
				if (!valid()) return;
				if (combine && result.revision !== previous?.revision) {
					combine = false;
					result = await api.querySessionCatalog({ query });
					if (!valid()) return;
				}
				pageKey.current = queryKey;
				pageScope.current = envKey;
				setPage({
					...result,
					sessions: combine ? [...(previous?.sessions ?? []), ...result.sessions] : result.sessions,
				});
			} catch {
				if (valid()) setError(true);
			} finally {
				if (valid()) setLoading(false);
			}
		},
		[api, online, queryKey, scopedCwd, search, sort, page, loading, envKey],
	);
	const loadRef = useRef(load);
	loadRef.current = load;
	useEffect(() => {
		if (!online) return;
		let active = true;
		let projectGeneration = 0;
		const refreshProjects = () => {
			const token = ++projectGeneration;
			void api
				.querySessionProjects()
				.then((value: SessionCatalogProjects) => {
					if (active && latestEnv.current === envKey && token === projectGeneration) setProjects(value);
				})
				.catch(() => {
					if (active && latestEnv.current === envKey && token === projectGeneration) setError(true);
				});
		};
		let off = () => {};
		try {
			off = api.onSessionCatalogChanged(() => {
				refreshProjects();
				void loadRef.current();
			});
			refreshProjects();
			void initDailyDir(environment)
				.then((value) => {
					if (active && latestEnv.current === envKey) setDaily(value);
				})
				.catch(() => {
					if (active && latestEnv.current === envKey) setError(true);
				});
		} catch {
			if (latestEnv.current === envKey) setError(true);
		}
		return () => {
			active = false;
			off();
		};
	}, [api, environment, online, envKey]);
	useEffect(() => {
		if (!online) {
			generation.current++;
			setLoading(false);
			return;
		}
		void loadRef.current(false, queryKey);
		return () => {
			generation.current++;
		};
	}, [online, queryKey]);

	const current = pageKey.current === queryKey;
	const mutate = async (session: SessionMeta, remove: boolean) => {
		if (!online || busy || loading || !current) return;
		setBusy(true);
		setOperationError(false);
		try {
			if (remove) await useProjectsStore.getState().deleteSession(session);
			else {
				if (!session.sessionFile || session.archiveRevision === undefined)
					throw new Error("Missing archive identity");
				const result = await api.unarchiveSession({
					sessionId: session.sessionId,
					sessionFile: session.sessionFile,
					expectedRevision: session.archiveRevision,
				});
				if (result.archived) throw new Error("Session remains archived");
			}
			if (latestKey.current !== queryKey) return;
			setPage((old) =>
				old ? { ...old, sessions: old.sessions.filter((item) => item.sessionId !== session.sessionId) } : old,
			);
			void loadRef.current();
		} catch {
			if (latestEnv.current === envKey && latestKey.current === queryKey) setOperationError(true);
		} finally {
			if (latestEnv.current === envKey) setBusy(false);
		}
	};
	const groups = new Map<string, SessionMeta[]>();
	const visiblePage = pageScope.current === envKey ? page : undefined;
	for (const session of visiblePage?.sessions ?? [])
		groups.set(session.cwd, [...(groups.get(session.cwd) ?? []), session]);
	const projectLabel = (path: string) => (path === daily ? t("sidebar.daily") : path);
	return (
		<div className="flex flex-col gap-3 text-ui-13">
			<h3 className="font-medium text-ink">{t("settings.category.archived")}</h3>
			<input
				aria-label={t("archive.search")}
				placeholder={t("archive.search")}
				value={search}
				onChange={(event) => setSearch(event.target.value)}
				className="w-full rounded-full border border-border bg-surface px-2.5 py-1.5 text-ui-12 text-ink focus-visible:outline-1 focus-visible:outline-ink-faint"
			/>
			<div className="flex min-w-0 gap-2">
				<Select
					ariaLabel={t("archive.project")}
					value={cwd}
					onChange={setCwd}
					options={[
						{ value: "", label: t("archive.allProjects") },
						...(daily ? [{ value: daily, label: t("sidebar.daily") }] : []),
						...(projects?.projects ?? [])
							.filter((p) => p.cwd !== daily)
							.map((p) => ({ value: p.cwd, label: projectLabel(p.cwd) })),
					]}
				/>
				<FilterIcon className="shrink-0 text-ink-faint" />
				<Select
					ariaLabel={t("archive.sort")}
					value={sort}
					onChange={(value) => setSort(value as SessionCatalogSort)}
					options={sorts.map((value) => ({ value, label: t(`archive.${value}`) }))}
				/>
			</div>
			{!online && <p className="text-ink-faint">{t("archive.offline")}</p>}
			{loading && <p className="text-ink-faint">{t("settings.loading")}</p>}
			{(error || operationError) && (
				<button
					type="button"
					className="self-start text-ink-dim hover:text-ink"
					onClick={() => {
						setOperationError(false);
						void load();
					}}
				>
					{t(operationError ? "archive.operationFailed" : "archive.error")} {t("sidebar.catalogRetry")}
				</button>
			)}
			{visiblePage && !visiblePage.complete && <p className="text-ink-faint">{t("archive.partial")}</p>}
			{current && visiblePage?.complete && !visiblePage.sessions.length && !loading && !error && (
				<p className="text-ink-faint">{t(search || cwd ? "archive.noMatch" : "archive.empty")}</p>
			)}
			{[...groups].map(([group, sessions]) => (
				<section key={group}>
					<h4 className="truncate text-ui-11 text-ink-faint">{projectLabel(group)}</h4>
					{sessions.map((session) => {
						const time =
							sort === "modified"
								? session.modifiedAt
								: sort === "created"
									? session.createdAt
									: session.archivedAt;
						const timeLabel =
							sort === "modified"
								? t("archive.modifiedTime")
								: sort === "created"
									? t("archive.createdTime")
									: t("archive.archivedTime");
						return (
							<div key={session.sessionId} className="flex items-center gap-2 py-2">
								<div className="min-w-0 flex-1">
									<div className="truncate text-ink">{session.name || t("projects.untitled")}</div>
									<div className="text-ui-11 text-ink-faint">
										{timeLabel}
										{time ? ` · ${new Date(time).toLocaleString()}` : ""}
									</div>
									{session.archiveCleanupPending && (
										<div className="text-ui-11 text-ink-faint">{t("archive.cleanupPending")}</div>
									)}
								</div>
								<Tooltip label={t("archive.unarchive")} align="end">
									<button
										type="button"
										aria-label={t("archive.unarchive")}
										disabled={!online || busy || loading || !current}
										onClick={() => void mutate(session, false)}
										className="rounded-lg p-1 text-ink-faint hover:bg-hover disabled:opacity-40"
									>
										<ArchiveIcon />
									</button>
								</Tooltip>
								<Tooltip label={t("sessionMenu.delete")} align="end">
									<button
										type="button"
										aria-label={t("sessionMenu.delete")}
										disabled={!online || busy || loading || !current}
										onClick={() => setDeleting(session)}
										className="rounded-lg p-1 text-ink-faint hover:bg-hover disabled:opacity-40"
									>
										<TrashIcon />
									</button>
								</Tooltip>
							</div>
						);
					})}
				</section>
			))}
			{current && page?.nextCursor && (
				<button
					type="button"
					disabled={!online || loading}
					onClick={() => void load(true)}
					className="self-start rounded-lg px-2 py-1 text-ink-dim hover:bg-hover disabled:opacity-40"
				>
					{t("sidebar.showMore")}
				</button>
			)}
			{deleting && (
				<ConfirmDialog
					title={t("sessionMenu.deleteTitle")}
					description={t("sessionMenu.deleteDesc")}
					confirmLabel={t("sessionMenu.delete")}
					cancelLabel={t("common.cancel")}
					danger
					onCancel={() => setDeleting(null)}
					onConfirm={() => {
						const target = deleting;
						setDeleting(null);
						void mutate(target, true);
					}}
				/>
			)}
		</div>
	);
}
