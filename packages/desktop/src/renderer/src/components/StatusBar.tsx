import { useEffect, useState } from "react";
import { getPi } from "../api";
import { useSessionsStore } from "../stores/sessions";

/** 状态栏：项目目录 + git 分支 */
export function StatusBar() {
	const cwd = useSessionsStore((s) => s.cwd);
	const pickDirectory = useSessionsStore((s) => s.pickDirectory);
	const [branch, setBranch] = useState<string | null>(null);

	useEffect(() => {
		setBranch(null);
		if (!cwd) return;
		let cancelled = false;
		void getPi()
			.getGitBranch(cwd)
			.then((b) => {
				if (!cancelled) setBranch(b);
			});
		return () => {
			cancelled = true;
		};
	}, [cwd]);

	return (
		<div className="flex h-6 shrink-0 items-center gap-3 border-t border-zinc-200 bg-[var(--color-bg)] px-4 text-[11px] text-zinc-400">
			<button
				type="button"
				className="transition-colors hover:text-zinc-700"
				onClick={() => void pickDirectory()}
				title="切换工作目录"
			>
				<span className="mr-1">🗂</span>
				{cwd ?? "未选择目录"}
			</button>
			<span className="text-zinc-200">|</span>
			<span title="git 分支">
				<span className="mr-1">⎇</span>
				{branch ?? "无 Git"}
			</span>
		</div>
	);
}
