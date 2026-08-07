import { useEffect } from "react";
import { useProjectsStore } from "../../stores/projects";
import { ProjectSidebar } from "./ProjectSidebar";
import { SearchBar } from "./SearchBar";
import { SessionPanel } from "./SessionPanel";

/** 项目管理页：顶部居中搜索 + 左列项目 + 右列会话（日期分组） */
export function ProjectPage() {
	const load = useProjectsStore((s) => s.load);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<SearchBar />
			<div className="flex min-h-0 flex-1">
				<ProjectSidebar />
				<SessionPanel />
			</div>
		</div>
	);
}
