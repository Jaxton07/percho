import { useT } from "../../i18n";
import type { SidebarProjectEntry } from "../../lib/sidebar-groups";
import { useProjectsStore } from "../../stores/projects";
import { ChevronDownIcon, PlusIcon } from "../icons";
import { SidebarGroup } from "./SidebarGroup";

/**
 * 「项目」小标 + 项目分组列表：小标整段可折叠（chevron 跟名字走、折叠后朝右），
 * 右侧常显一个「＋」添加项目（不再藏在 hover 里，也不再占列表底部）。
 * 折叠只影响项目行，「＋」照常在（画板 D ④）。
 */
export function ProjectSection({
	projects,
	expanded,
	activeSessionId,
	onToggle,
	onToggleGroup,
	onTogglePin,
	onRemoveProject,
}: {
	projects: SidebarProjectEntry[];
	expanded: boolean;
	activeSessionId: string | null;
	onToggle: () => void;
	onToggleGroup: (key: string) => void;
	onTogglePin: (cwd: string) => void;
	onRemoveProject: (cwd: string) => void;
}) {
	const t = useT();
	const addProject = useProjectsStore((s) => s.addProject);
	return (
		<div>
			<div className="group/sect mt-2 flex h-7 items-center gap-[5px] rounded-[7px] px-[6px] text-[11px] tracking-[0.03em] text-ink-faint">
				<button
					type="button"
					aria-expanded={expanded}
					className="flex min-w-0 flex-1 items-center gap-[5px] text-left transition-colors hover:text-ink-dim"
					onClick={onToggle}
				>
					<span className="truncate">{t("sidebar.projectsSection")}</span>
					<ChevronDownIcon
						size={12}
						className={`shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`}
					/>
				</button>
				<button
					type="button"
					aria-label={t("sidebar.addProject")}
					className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-hover hover:text-ink"
					onClick={() => void addProject()}
				>
					<PlusIcon size={15} />
				</button>
			</div>
			{expanded &&
				projects.map((project) => (
					<SidebarGroup
						key={project.cwd}
						group={project}
						activeSessionId={activeSessionId}
						pinned={project.pinned}
						totalSessions={project.totalSessions}
						onToggle={onToggleGroup}
						onTogglePin={onTogglePin}
						onRemove={() => onRemoveProject(project.cwd)}
					/>
				))}
		</div>
	);
}
