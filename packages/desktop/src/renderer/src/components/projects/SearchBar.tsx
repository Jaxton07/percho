import { useMemo } from "react";
import { useT } from "../../i18n";
import { deriveProjects, useProjectsStore } from "../../stores/projects";
import { SearchIcon } from "../icons";

/** 顶部居中搜索框：按会话名/id 过滤 */
export function SearchBar() {
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
				<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
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
