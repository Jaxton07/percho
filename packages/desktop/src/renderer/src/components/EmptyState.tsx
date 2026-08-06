import { useEffect } from "react";
import { useProjectsStore } from "../stores/projects";
import { useSessionsStore } from "../stores/sessions";
import { Composer } from "./Composer";
import { ProjectBranchPicker } from "./ProjectBranchPicker";

/** 空态：大字 Logo + 居中输入框 + 项目/分支选择（对标 opencode 新会话页） */
export function EmptyState() {
	const error = useSessionsStore((s) => s.error);
	const load = useProjectsStore((s) => s.load);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<div className="flex h-full flex-col items-center justify-center gap-8 px-8 pb-[8vh]">
			<div className="text-7xl font-extrabold tracking-tight text-zinc-200 select-none">pi</div>
			{error && <p className="max-w-md text-center text-xs text-red-500">{error}</p>}
			<Composer centered />
			<ProjectBranchPicker />
		</div>
	);
}
