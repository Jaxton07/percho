import { useMemo, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { deriveProjects, useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { CloseIcon, GearIcon, HelpIcon, PlusIcon } from "../icons";

const PI_REPO_URL = "https://github.com/earendil-works/pi";

/** 项目列表侧栏：项目项 + 底部设置/帮助入口 */
export function ProjectSidebar() {
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
	const deleteProject = useProjectsStore((s) => s.deleteProject);
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
					<PlusIcon />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
				{projects.length === 0 && (
					<p className="px-2 py-6 text-center text-[12px] text-zinc-400">{t("projects.noProjects")}</p>
				)}
				{projects.map((project) => (
					<ProjectItem
						key={project.cwd}
						project={project}
						isActive={project.cwd === selectedCwd}
						onSelect={() => select(project.cwd)}
						onDelete={() => void deleteProject(project.cwd)}
					/>
				))}
			</div>
			<div className="shrink-0 px-3 py-3">
				<button
					type="button"
					className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-800"
					onClick={() => openSettings(true)}
				>
					<GearIcon />
					{t("tabbar.settings")}
				</button>
				<button
					type="button"
					className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-800"
					onClick={() => void getPi().openExternal(PI_REPO_URL)}
				>
					<HelpIcon />
					{t("projects.help")}
				</button>
			</div>
		</aside>
	);
}

/** 项目项：点击选中，hover 出现删除（二次确认，删除该项目全部会话） */
function ProjectItem({
	project,
	isActive,
	onSelect,
	onDelete,
}: {
	project: { cwd: string; name: string };
	isActive: boolean;
	onSelect: () => void;
	onDelete: () => void;
}) {
	const t = useT();
	const [confirming, setConfirming] = useState(false);

	return (
		<div className="group relative mb-0.5">
			<button
				type="button"
				className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
					isActive ? "bg-zinc-100 text-zinc-900" : "text-zinc-600 hover:bg-zinc-50"
				}`}
				onClick={onSelect}
				title={project.cwd}
			>
				<span
					className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold text-white ${
						isActive ? "bg-violet-500" : "bg-zinc-400"
					}`}
				>
					{(project.name[0] ?? "P").toUpperCase()}
				</span>
				<span className="min-w-0 flex-1 truncate">{project.name}</span>
			</button>
			<button
				type="button"
				className={`invisible absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[11px] transition-colors group-hover:visible ${
					confirming ? "bg-red-50 text-red-600" : "text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
				}`}
				onClick={() => {
					if (confirming) {
						onDelete();
					} else {
						setConfirming(true);
					}
				}}
				title={t("projects.deleteProject")}
			>
				{confirming ? t("projects.confirmDeleteProject") : <CloseIcon />}
			</button>
		</div>
	);
}
