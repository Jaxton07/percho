import { useMemo } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { deriveSidebarGroups } from "../../lib/sidebar-groups";
import { deriveProjects, useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { ProjectSection } from "./ProjectSection";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarGroup } from "./SidebarGroup";
import { SidebarHeader } from "./SidebarHeader";
import { useExpandedGroups } from "./useExpandedGroups";

/**
 * 左侧栏容器（Codex 式常驻导航）：只做「取 store 数据 → 调纯函数派生 → 分发 props」，
 * 不碰持久化、不碰 IPC。宽度 240 ↔ 0 的过渡在 globals.css 的 .sidebar 段（push 式，内层固定 240
 * 所以过渡期间内容只被推走、不被横向挤压）。收起时整栏 `inert`：不接指针也不进 Tab 序。
 */
export function Sidebar() {
	const t = useT();
	const collapsed = useUiPreferencesStore((s) => s.sidebarCollapsed);
	const expandedGroups = useUiPreferencesStore((s) => s.expandedGroups);
	const pinnedProjects = useUiPreferencesStore((s) => s.pinnedProjects);
	const pinnedSessions = useUiPreferencesStore((s) => s.pinnedSessions);
	const toggleProjectPin = useUiPreferencesStore((s) => s.toggleProjectPin);
	const search = useProjectsStore((s) => s.search);
	const allSessions = useProjectsStore((s) => s.allSessions);
	const addedProjects = useProjectsStore((s) => s.addedProjects);
	const deleteProject = useProjectsStore((s) => s.deleteProject);
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const { toggleGroup } = useExpandedGroups();

	const data = useMemo(
		() =>
			deriveSidebarGroups({
				sessions: allSessions,
				// 项目表复用项目页那套派生（已排除日常目录、含「只有会话」与「手动添加」两类）
				projects: deriveProjects({ allSessions, addedProjects }),
				search,
				activeSessionId,
				pinnedSessions,
				pinnedProjects,
				expandedGroups,
			}),
		[allSessions, addedProjects, search, activeSessionId, pinnedSessions, pinnedProjects, expandedGroups],
	);

	// 首次开合的起点由派生层给（当前会话所在组 + 项目小标），组件不自己再算一遍
	const defaults = data.defaultExpandedKeys;
	const onToggleGroup = (key: string) => toggleGroup(key, defaults);
	const empty = data.daily === null && data.projects.length === 0;

	return (
		<aside
			className={`sidebar ${collapsed ? "is-collapsed" : ""}`}
			aria-label={t("sidebar.title")}
			inert={collapsed}
		>
			<div className="sidebar-inner">
				<SidebarHeader platform={getPi().platform} />
				<div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pt-0.5 pb-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
					{data.daily && (
						<SidebarGroup group={data.daily} activeSessionId={activeSessionId} onToggle={onToggleGroup} />
					)}
					<ProjectSection
						projects={data.projects}
						activeSessionId={activeSessionId}
						onToggleGroup={onToggleGroup}
						onTogglePin={toggleProjectPin}
						onRemoveProject={(cwd) => void deleteProject(cwd)}
					/>
					{empty && (
						<p className="px-1.5 py-6 text-center text-[12px] text-ink-faint">
							{search ? t("sidebar.searchEmpty") : t("sidebar.noSessions")}
						</p>
					)}
				</div>
				<SidebarFooter />
			</div>
		</aside>
	);
}
