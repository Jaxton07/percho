import { useMemo, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { deriveProjects, useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { CloseIcon, GearIcon, HelpIcon, PlusIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";

/** 项目仓库地址（帮助按钮跳转） */
const PI_REPO_URL = "https://github.com/Jaxton07/pi-desktop";

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
		<aside className="flex w-60 shrink-0 flex-col border-r border-border">
			<div className="flex items-center justify-between px-4 pt-3 pb-2">
				<span className="text-[13px] font-medium text-ink">{t("projects.title")}</span>
				<Tooltip label={t("projects.addProject")}>
					<button
						type="button"
						className="rounded-lg p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
						onClick={() => void addProject()}
						aria-label={t("projects.addProject")}
					>
						<PlusIcon />
					</button>
				</Tooltip>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
				{projects.length === 0 && (
					<p className="px-2 py-6 text-center text-[12px] text-ink-faint">{t("projects.noProjects")}</p>
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
					className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
					onClick={() => openSettings(true)}
				>
					<GearIcon />
					{t("tabbar.settings")}
				</button>
				<button
					type="button"
					className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
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
					isActive ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover"
				}`}
				onClick={onSelect}
				title={project.cwd}
			>
				<span
					className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold text-on-ink ${
						isActive ? "bg-ink" : "bg-ink-faint"
					}`}
				>
					{(project.name[0] ?? "P").toUpperCase()}
				</span>
				<span className="min-w-0 flex-1 truncate">{project.name}</span>
			</button>
			<button
				type="button"
				className={`invisible absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[11px] transition-colors group-hover:visible ${
					confirming ? "bg-red-50 text-red-600" : "text-ink-faint hover:bg-hover hover:text-ink-2"
				}`}
				onClick={() => {
					if (confirming) {
						onDelete();
					} else {
						setConfirming(true);
					}
				}}
			>
				{confirming ? t("projects.confirmDeleteProject") : <CloseIcon />}
			</button>
		</div>
	);
}
