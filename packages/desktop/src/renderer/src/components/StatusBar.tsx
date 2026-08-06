import { useEffect, useState } from "react";
import { getPi } from "../api";
import { useT } from "../i18n";
import { useSessionsStore } from "../stores/sessions";

/** 状态栏：项目目录 + git 分支 */
export function StatusBar() {
	const t = useT();
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
				title={t("common.switchDir")}
			>
				<span className="mr-1">🗂</span>
				{cwd ?? t("statusbar.noDir")}
			</button>
			<span className="text-zinc-200">|</span>
			<span title={t("statusbar.gitBranch")}>
				<span className="mr-1">⎇</span>
				{branch ?? t("statusbar.noGit")}
			</span>
		</div>
	);
}
