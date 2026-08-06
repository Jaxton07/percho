import type { SessionMeta } from "@pi-desktop/shared";
import { useEffect, useMemo, useState } from "react";
import { getPi } from "../api";
import { useT } from "../i18n";
import { deriveProjects, deriveSessions, useProjectsStore } from "../stores/projects";
import { useSessionsStore } from "../stores/sessions";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";

const PI_REPO_URL = "https://github.com/earendil-works/pi";

/** 项目管理页：顶部居中搜索 + 左列项目 + 右列会话（日期分组），整体为圆角卡片 */
export function ProjectPage() {
	const load = useProjectsStore((s) => s.load);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<div className="flex h-full flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white">
			<SearchBar />
			<div className="flex min-h-0 flex-1">
				<ProjectSidebar />
				<SessionPanel />
			</div>
		</div>
	);
}

function SearchBar() {
	const t = useT();
	const search = useProjectsStore((s) => s.search);
	const setSearch = useProjectsStore((s) => s.setSearch);
	const selectedCwd = useProjectsStore((s) => s.selectedCwd);
	const allSessions = useProjectsStore((s) => s.allSessions);
	const addedProjects = useProjectsStore((s) => s.addedProjects);
	const projects = useMemo(
		() => deriveProjects({ allSessions, addedProjects }),
		[allSessions, addedProjects],
	);
	const project = projects.find((p) => p.cwd === selectedCwd);

	return (
		<div className="flex shrink-0 justify-center px-6 pt-5 pb-2">
			<div className="relative w-full max-w-md">
				<svg
					className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400"
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					aria-hidden="true"
				>
					<circle cx="11" cy="11" r="7" />
					<path d="m20 20-3.5-3.5" strokeLinecap="round" />
				</svg>
				<input
					className="w-full rounded-lg bg-zinc-100/80 py-2 pl-9 pr-3 text-[13px] outline-none placeholder:text-zinc-400 focus:bg-zinc-100"
					placeholder={t("projects.search", { project: project?.name ?? "" })}
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
			</div>
		</div>
	);
}

function ProjectSidebar() {
	const t = useT();
	const allSessions = useProjectsStore((s) => s.allSessions);
	const addedProjects = useProjectsStore((s) => s.addedProjects);
	const projects = useMemo(
		() => deriveProjects({ allSessions, addedProjects }),
		[allSessions, addedProjects],
	);
	const selectedCwd = useProjectsStore((s) => s.selectedCwd);
	const select = useProjectsStore((s) => s.select);
	const addProject = useProjectsStore((s) => s.addProject);
	const openSettings = useSettingsStore((s) => s.setOpen);

	return (
		<aside className="flex w-60 shrink-0 flex-col border-r border-zinc-100">
			<div className="flex items-center justify-between px-4 pt-3 pb-2">
				<span className="text-[13px] font-medium text-zinc-800">{t("projects.title")}</span>
				<button
					type="button"
					className="rounded-lg p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
					onClick={() => void addProject()}
					title={t("projects.addProject")}
					aria-label={t("projects.addProject")}
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						aria-hidden="true"
					>
						<path d="M12 5v14M5 12h14" strokeLinecap="round" />
					</svg>
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
				{projects.length === 0 && (
					<p className="px-2 py-6 text-center text-[12px] text-zinc-400">{t("projects.noProjects")}</p>
				)}
				{projects.map((project) => {
					const isActive = project.cwd === selectedCwd;
					return (
						<button
							key={project.cwd}
							type="button"
							className={`mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
								isActive ? "bg-zinc-100 text-zinc-900" : "text-zinc-600 hover:bg-zinc-50"
							}`}
							onClick={() => select(project.cwd)}
							title={project.cwd}
						>
							<span
								className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold text-white ${
									isActive ? "bg-violet-500" : "bg-zinc-400"
								}`}
							>
								{(project.name[0] ?? "P").toUpperCase()}
							</span>
							<span className="truncate">{project.name}</span>
						</button>
					);
				})}
			</div>
			<div className="shrink-0 px-3 py-3">
				<button
					type="button"
					className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-800"
					onClick={() => openSettings(true)}
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<circle cx="12" cy="12" r="3" />
						<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
					</svg>
					{t("tabbar.settings")}
				</button>
				<button
					type="button"
					className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-800"
					onClick={() => void getPi().openExternal(PI_REPO_URL)}
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<circle cx="12" cy="12" r="10" />
						<path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
						<path d="M12 17h.01" />
					</svg>
					{t("projects.help")}
				</button>
			</div>
		</aside>
	);
}

function SessionPanel() {
	const t = useT();
	const selectedCwd = useProjectsStore((s) => s.selectedCwd);
	const search = useProjectsStore((s) => s.search);
	const allSessions = useProjectsStore((s) => s.allSessions);
	const sessions = useMemo(
		() => deriveSessions({ allSessions, selectedCwd, search }),
		[allSessions, selectedCwd, search],
	);
	const createSession = useSessionsStore((s) => s.createSession);
	const setView = useUiStore((s) => s.setView);

	const groups = groupByDate(sessions);
	const groupLabels = {
		today: t("projects.today"),
		yesterday: t("projects.yesterday"),
		earlier: t("projects.earlier"),
	} as const;

	const newSession = async () => {
		if (!selectedCwd) return;
		await createSession(selectedCwd);
		setView("chat");
	};

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center justify-end px-5 pt-3">
				<button
					type="button"
					className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40"
					onClick={() => void newSession()}
					disabled={!selectedCwd}
				>
					<ComposeIcon />
					{t("projects.newSession")}
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
				{sessions.length === 0 && (
					<p className="py-10 text-center text-[13px] text-zinc-400">{t("projects.noSessions")}</p>
				)}
				{groups.map((group) => (
					<div key={group.key}>
						<h3 className="pt-4 pb-2 text-[13px] font-medium text-zinc-500">{groupLabels[group.key]}</h3>
						<ul className="flex flex-col gap-0.5">
							{group.sessions.map((session) => (
								<SessionRow key={session.sessionId} session={session} />
							))}
						</ul>
					</div>
				))}
			</div>
		</div>
	);
}

function SessionRow({ session }: { session: SessionMeta }) {
	const t = useT();
	const openSession = useProjectsStore((s) => s.openSession);
	const deleteSession = useProjectsStore((s) => s.deleteSession);
	const setView = useUiStore((s) => s.setView);
	const [confirming, setConfirming] = useState(false);

	return (
		<li className="group relative">
			<button
				type="button"
				className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-zinc-50"
				onClick={() => {
					if (session.sessionFile) {
						void openSession(session.sessionFile).then(() => setView("chat"));
					}
				}}
			>
				<span className="min-w-0 flex-1 truncate text-[13px] text-zinc-800">
					{session.name ?? t("projects.untitled")}
				</span>
				<span className="shrink-0 text-[11px] text-zinc-400 group-hover:invisible">
					{t("projects.messages", { count: session.messageCount })}
				</span>
			</button>
			<button
				type="button"
				className={`invisible absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[11px] transition-colors group-hover:visible ${
					confirming ? "bg-red-50 text-red-600" : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
				}`}
				onClick={() => {
					if (confirming) {
						void deleteSession(session);
					} else {
						setConfirming(true);
						setTimeout(() => setConfirming(false), 2000);
					}
				}}
				title={t("projects.delete")}
			>
				{confirming ? (
					t("projects.confirmDelete")
				) : (
					<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
						<path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
					</svg>
				)}
			</button>
		</li>
	);
}

function groupByDate(
	sessions: SessionMeta[],
): { key: "today" | "yesterday" | "earlier"; sessions: SessionMeta[] }[] {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
	const groups = new Map<"today" | "yesterday" | "earlier", SessionMeta[]>();
	for (const session of sessions) {
		const time = session.modifiedAt ?? session.createdAt;
		const key = time >= startOfToday ? "today" : time >= startOfYesterday ? "yesterday" : "earlier";
		const list = groups.get(key) ?? [];
		list.push(session);
		groups.set(key, list);
	}
	const order = ["today", "yesterday", "earlier"] as const;
	return order.filter((key) => groups.has(key)).map((key) => ({ key, sessions: groups.get(key) ?? [] }));
}

/** codex 风格「新会话」编辑图标 */
export function ComposeIcon({ size = 14 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M12 20h9" />
			<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
		</svg>
	);
}
