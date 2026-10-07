import { useT } from "../../i18n";
import type { SidebarProjectEntry } from "../../lib/sidebar-groups";
import { useProjectsStore } from "../../stores/projects";
import { PlusIcon } from "../icons";
import { SidebarGroup } from "./SidebarGroup";
import type { SidebarBatching } from "./useSidebarBatching";

/**
 * 「项目」小标 + 项目分组列表：**v7 起只是一个固定标题分割区，不可折叠**（用户：大栏折叠意义不大）；
 * 右侧常显一个「＋」添加项目（不藏在 hover 里，也不占列表底部）。
 * `batching` 原样过给每个分组（分批显示 + 搜索临时态），本组件不解读它。
 */
export function ProjectSection({
	projects,
	activeSessionId,
	batching,
	onTogglePin,
	onRemoveProject,
}: {
	projects: SidebarProjectEntry[];
	activeSessionId: string | null;
	batching: SidebarBatching;
	onTogglePin: (cwd: string) => void;
	onRemoveProject: (cwd: string) => void;
}) {
	const t = useT();
	const addProject = useProjectsStore((s) => s.addProject);
	return (
		<div>
			<div className="group/sect mt-2 flex h-8 items-center gap-[5px] rounded-[7px] px-[6px] text-ui-15 font-medium text-ink-dim">
				<span className="min-w-0 flex-1 truncate">{t("sidebar.projectsSection")}</span>
				<button
					type="button"
					aria-label={t("sidebar.addProject")}
					className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-hover hover:text-ink"
					onClick={() => void addProject()}
				>
					<PlusIcon size={15} />
				</button>
			</div>
			{projects.map((project) => (
				<SidebarGroup
					key={project.cwd}
					group={project}
					activeSessionId={activeSessionId}
					pinned={project.pinned}
					totalSessions={project.totalSessions}
					batching={batching}
					onTogglePin={onTogglePin}
					onRemove={() => onRemoveProject(project.cwd)}
				/>
			))}
		</div>
	);
}
