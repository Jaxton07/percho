import { type CSSProperties, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { deriveSidebarNavigation } from "../../lib/sidebar-groups";
import { useEdgeFade } from "../../lib/use-edge-fade";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { ProjectSection } from "./ProjectSection";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarGroup } from "./SidebarGroup";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { useSidebarBatching } from "./useSidebarBatching";
import { useSidebarRenderWidth } from "./useSidebarRenderWidth";

/**
 * 左侧栏容器（Codex 式常驻导航）：只做「取 store 数据 → 调纯函数派生 → 分发 props」，
 * 不碰持久化、不碰 IPC。宽度 240 ↔ 0 的过渡在 globals.css 的 .sidebar 段（push 式，内层固定 240
 * 所以过渡期间内容只被推走、不被横向挤压）。收起时整栏 `inert`：不接指针也不进 Tab 序。
 * 「每组 6 条 + 显示更多」与搜索临时展开的**内存态**在 `useSidebarBatching`（不持久化、不新增 IPC），
 * 本组件只负责把它和派生结果一起分发下去。宽度与开合动画不受分批影响。
 *
 * 宽度：store 里的 `sidebarWidth` 是**用户意图值**，这里用 `useSidebarRenderWidth` 派生出**渲染宽**
 * （容器宽不够时二次夹紧），写成 `--sidebar-render-width` 由 `.sidebar` 与 `.sidebar-inner` **共用**——
 * 内外层不同值的话，窄窗下内层右侧会被 overflow:hidden 硬裁掉功能控件（见 lib/sidebar-width.ts）。
 */
export function Sidebar() {
	const t = useT();
	const collapsed = useUiPreferencesStore((s) => s.sidebarCollapsed);
	const sidebarWidth = useUiPreferencesStore((s) => s.sidebarWidth);
	const [resizing, setResizing] = useState(false);
	const asideRef = useRef<HTMLElement>(null);
	const renderWidth = useSidebarRenderWidth(sidebarWidth, asideRef);
	const expandedGroups = useUiPreferencesStore((s) => s.expandedGroups);
	const expandedGroupsTouched = useUiPreferencesStore((s) => s.expandedGroupsTouched);
	const pinnedProjects = useUiPreferencesStore((s) => s.pinnedProjects);
	const pinnedSessions = useUiPreferencesStore((s) => s.pinnedSessions);
	const toggleProjectPin = useUiPreferencesStore((s) => s.toggleProjectPin);
	const search = useProjectsStore((s) => s.search);
	const allSessions = useProjectsStore((s) => s.allSessions);
	const addedProjects = useProjectsStore((s) => s.addedProjects);
	const deleteProject = useProjectsStore((s) => s.deleteProject);
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	// 内存会话（含刚创建还没进历史的真实会话与只读子会话）：与磁盘历史合并成左栏数据源（spec D2）
	const memorySessions = useSessionsStore((s) => s.sessions);
	// 默认展开组用「当前目录」：真实会话 = 它的项目；新会话页 = draft 的目录（store.cwd 两处都已镜像）
	const activeCwd = useSessionsStore((s) => s.cwd);

	// 装配全在纯函数层（含只读子会话过滤 + 项目表同源），Sidebar 只负责取数与分发
	const data = useMemo(
		() =>
			deriveSidebarNavigation({
				history: allSessions,
				memory: memorySessions,
				addedProjects,
				search,
				activeCwd,
				pinnedSessions,
				pinnedProjects,
				expandedGroups,
				expandedGroupsTouched,
			}),
		[
			allSessions,
			memorySessions,
			addedProjects,
			search,
			activeCwd,
			pinnedSessions,
			pinnedProjects,
			expandedGroups,
			expandedGroupsTouched,
		],
	);

	// 分批显示（每组 6 条 + 显示更多）与搜索临时展开：纯内存态，只在渲染时叠加到派生结果上。
	// 首次开合的起点由派生层给（当前会话所在组），组件不自己再算一遍。
	const batching = useSidebarBatching({ search, defaults: data.defaultExpandedKeys });
	const empty = data.daily === null && data.projects.length === 0;

	// 左栏唯一滚动容器的边界淡出（底部下沿淡出，原来这里是一条 1px 实线）
	const sidebarScrollRef = useRef<HTMLDivElement>(null);
	useEdgeFade(sidebarScrollRef);

	return (
		<aside
			ref={asideRef}
			className={`sidebar fade-rule-v ${collapsed ? "is-collapsed" : ""} ${resizing ? "is-resizing" : ""}`}
			style={{ "--sidebar-render-width": `${renderWidth}px` } as CSSProperties}
			aria-label={t("sidebar.title")}
			inert={collapsed}
		>
			{/* 折叠态不渲染把手：宽度已归 0，它会被裁看不见，还会多一个 Tab 序 */}
			{!collapsed && <SidebarResizeHandle value={renderWidth} onResizingChange={setResizing} />}
			<div className="sidebar-inner">
				<SidebarHeader />
				{/* 左栏唯一的外层滚动容器：验收脚本用 `data-sidebar-scroll-root` 定位它（纯属性，无视觉影响） */}
				<div
					ref={sidebarScrollRef}
					data-sidebar-scroll-root=""
					style={{ "--edge-fade-size": "16px" } as CSSProperties}
					className="edge-fade min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pt-0.5 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				>
					{data.daily && (
						<SidebarGroup group={data.daily} activeSessionId={activeSessionId} batching={batching} />
					)}
					<ProjectSection
						projects={data.projects}
						activeSessionId={activeSessionId}
						batching={batching}
						onTogglePin={toggleProjectPin}
						onRemoveProject={(cwd) => {
							// 计数等删除真的成功再清：失败了就留着，别让「已显示多少条」比真实数据跑在前面
							void deleteProject(cwd).then(
								() => batching.forget(cwd),
								(error: unknown) => console.error("移除项目失败", error),
							);
						}}
					/>
					{empty && (
						<p className="px-1.5 py-6 text-center text-ui-12 text-ink-faint">
							{search ? t("sidebar.searchEmpty") : t("sidebar.noSessions")}
						</p>
					)}
				</div>
				<SidebarFooter />
			</div>
		</aside>
	);
}
