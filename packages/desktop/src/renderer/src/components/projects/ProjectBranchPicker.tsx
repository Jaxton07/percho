import { useEffect, useMemo, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { getDailyDirCached, isDailyCwd } from "../../lib/daily";
import { deriveProjects, useProjectsStore } from "../../stores/projects";
import { isDraftSessionId, useSessionsStore } from "../../stores/sessions";
import { CoffeeIcon } from "../icons";
import { Dropdown } from "../ui/Dropdown";

/** 空态 Composer 下方：项目目录选择 + git 分支选择（对标 opencode） */
export function ProjectBranchPicker() {
	const cwd = useSessionsStore((s) => s.cwd);
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	// 真实会话的项目在创建时已绑定、不可更改：只在无会话 / draft（新会话）时提供切换，
	// 避免选择器看起来能切、实际不生效的假交互
	if (activeSessionId && !isDraftSessionId(activeSessionId)) return null;
	// 日常空间目录不是 git 仓库：隐藏分支选择器，只留归属 chip（可下拉切回项目）
	const daily = isDailyCwd(cwd);
	return (
		<div className="flex items-center justify-center gap-2 text-[13px] text-ink-dim">
			<ProjectPicker />
			{!daily && (
				<>
					<span className="text-border-strong">/</span>
					<BranchPicker key={cwd ?? "none"} cwd={cwd} />
				</>
			)}
		</div>
	);
}

function ProjectPicker() {
	const t = useT();
	const cwd = useSessionsStore((s) => s.cwd);
	const pickDirectory = useSessionsStore((s) => s.pickDirectory);
	const setDraftCwd = useSessionsStore((s) => s.setDraftCwd);
	const allSessions = useProjectsStore((s) => s.allSessions);
	const addedProjects = useProjectsStore((s) => s.addedProjects);
	const projects = useMemo(
		() => deriveProjects({ allSessions, addedProjects }),
		[allSessions, addedProjects],
	);
	const name = cwd?.split("/").filter(Boolean).pop();
	const daily = isDailyCwd(cwd);
	// 模块缓存（load() 已 await 初始化；空态 EmptyState 挂载即触发 load）
	const dailyDir = getDailyDirCached();

	return (
		<Dropdown
			trigger={
				<span className="flex items-center gap-1.5">
					{daily ? (
						<span className="flex h-4.5 w-4.5 items-center justify-center rounded border border-border-strong bg-canvas text-ink">
							<CoffeeIcon size={10} />
						</span>
					) : (
						<span className="flex h-4.5 w-4.5 items-center justify-center rounded bg-ink text-[10px] font-semibold text-on-ink">
							{(name?.[0] ?? "P").toUpperCase()}
						</span>
					)}
					{daily ? t("projects.daily") : (name ?? t("projects.selectProject"))}
				</span>
			}
		>
			{(close) => (
				<>
					{/* 日常空间钉顶：draft 可在 日常 ↔ 项目 间双向切换（与侧栏同一空间语义） */}
					{dailyDir && (
						<>
							<button
								type="button"
								className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-hover ${
									daily ? "text-ink" : "text-ink-2"
								}`}
								onClick={() => {
									setDraftCwd(dailyDir);
									close();
								}}
							>
								<span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border border-border-strong bg-canvas text-ink">
									<CoffeeIcon size={10} />
								</span>
								<span className="truncate">{t("projects.daily")}</span>
							</button>
							{projects.length > 0 && <div className="my-0.5 border-t border-border" />}
						</>
					)}
					{projects.map((project) => (
						<button
							key={project.cwd}
							type="button"
							className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-hover ${
								project.cwd === cwd ? "text-ink" : "text-ink-2"
							}`}
							onClick={() => {
								// draft 场景下同步更新 draft 条目的 cwd，发送首条消息时即用此目录创建
								setDraftCwd(project.cwd);
								close();
							}}
						>
							<span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded bg-ink-faint text-[10px] font-semibold text-on-ink">
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
