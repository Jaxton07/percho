import { useEffect, useMemo, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { deriveProjects, useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { Dropdown } from "../ui/Dropdown";

/** 空态 Composer 下方：项目目录选择 + git 分支选择（对标 opencode） */
export function ProjectBranchPicker() {
	const cwd = useSessionsStore((s) => s.cwd);
	return (
		<div className="flex items-center justify-center gap-2 text-[13px] text-ink-dim">
			<ProjectPicker />
			<span className="text-border-strong">/</span>
			<BranchPicker key={cwd ?? "none"} cwd={cwd} />
		</div>
	);
}

function ProjectPicker() {
	const t = useT();
	const cwd = useSessionsStore((s) => s.cwd);
	const pickDirectory = useSessionsStore((s) => s.pickDirectory);
	const allSessions = useProjectsStore((s) => s.allSessions);
	const addedProjects = useProjectsStore((s) => s.addedProjects);
	const projects = useMemo(
		() => deriveProjects({ allSessions, addedProjects }),
		[allSessions, addedProjects],
	);
	const name = cwd?.split("/").filter(Boolean).pop();

	return (
		<Dropdown
			trigger={
				<span className="flex items-center gap-1.5">
					<span className="flex h-4.5 w-4.5 items-center justify-center rounded bg-emerald-600 text-[10px] font-semibold text-white">
						{(name?.[0] ?? "P").toUpperCase()}
					</span>
					{name ?? t("projects.selectProject")}
				</span>
			}
		>
			{(close) => (
				<>
					{projects.map((project) => (
						<button
							key={project.cwd}
							type="button"
							className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-hover ${
								project.cwd === cwd ? "text-ink" : "text-ink-2"
							}`}
							onClick={() => {
								useSessionsStore.setState({ cwd: project.cwd });
								close();
							}}
						>
							<span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded bg-ink-faint text-[10px] font-semibold text-white">
								{(project.name[0] ?? "P").toUpperCase()}
							</span>
							<span className="truncate">{project.name}</span>
						</button>
					))}
					<button
						type="button"
						className="mt-0.5 flex w-full items-center gap-2 rounded-md border-t border-border px-2 py-1.5 text-left text-[13px] text-ink-dim transition-colors hover:bg-hover"
						onClick={() => {
							void pickDirectory();
							close();
						}}
					>
						{t("projects.selectProject")}…
					</button>
				</>
			)}
		</Dropdown>
	);
}

function BranchPicker({ cwd }: { cwd: string | null }) {
	const t = useT();
	const [branches, setBranches] = useState<string[]>([]);
	const [current, setCurrent] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!cwd) return;
		let cancelled = false;
		void getPi()
			.listGitBranches(cwd)
			.then((result) => {
				if (cancelled) return;
				setBranches(result.branches);
				setCurrent(result.current);
			});
		return () => {
			cancelled = true;
		};
	}, [cwd]);

	if (!cwd || !current) {
		return <span className="text-ink-faint">⎇ {t("projects.noGit")}</span>;
	}

	return (
		<>
			<Dropdown
				trigger={
					<span className="flex items-center gap-1.5">
						<span aria-hidden="true">⎇</span>
						{current}
					</span>
				}
			>
				{(close) => (
					<>
						{branches.map((branch) => (
							<button
								key={branch}
								type="button"
								className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-hover ${
									branch === current ? "font-medium text-ink" : "text-ink-2"
								}`}
								onClick={() => {
									if (branch !== current && cwd) {
										void getPi()
											.checkoutBranch(cwd, branch)
											.then(setCurrent)
											.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
									}
									close();
								}}
							>
								<span aria-hidden="true">⎇</span>
								<span className="truncate">{branch}</span>
							</button>
						))}
					</>
				)}
			</Dropdown>
			{error && <span className="text-[11px] text-red-500">{error}</span>}
		</>
	);
}
