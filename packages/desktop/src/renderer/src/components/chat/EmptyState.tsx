import { useEffect } from "react";
import { useProjectsStore } from "../../stores/projects";
import { Composer } from "../composer/Composer";
import { ProjectBranchPicker } from "../projects/ProjectBranchPicker";
import { WordmarkConstruct } from "./WordmarkConstruct";

/** 空态：大字 Logo + 居中输入框 + 项目/分支选择（对标 opencode 新会话页） */
export function EmptyState() {
	const load = useProjectsStore((s) => s.load);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<div className="flex h-full flex-col items-center justify-center gap-8 px-8 pb-[8vh]">
			<WordmarkConstruct />
			<Composer centered />
			<ProjectBranchPicker />
		</div>
	);
}
