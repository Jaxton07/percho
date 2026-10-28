import { environmentEntityRef, LOCAL_ENVIRONMENT, sameEnvironment } from "@percho/shared";
import { useEffect, useMemo, useState } from "react";
import { getExecutionApi } from "../../environment-api";
import { useT } from "../../i18n";
import { selectActiveCwd } from "../../lib/active-cwd";
import { getDailyDirCached, isDailyCwd } from "../../lib/daily";
import { pathLastSegment } from "../../lib/path-display";
import { deriveProjects, useProjectsStore } from "../../stores/projects";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { useSessionsStore } from "../../stores/sessions";
import { CoffeeIcon } from "../icons";
import { RemoteEnvironmentIndicator } from "../remote/RemoteEnvironmentIndicator";
import { AddProjectDialog } from "../sidebar/AddProjectDialog";
import { Dropdown } from "../ui/Dropdown";

/** 空态 Composer 下方：项目目录选择 + git 分支选择（对标 opencode） */
export function ProjectBranchPicker() {
	const cwd = useSessionsStore(selectActiveCwd);
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	// 真实会话的项目在创建时已绑定、不可更改：只在新会话页（无 active）提供切换，
	// 避免选择器看起来能切、实际不生效的假交互
	if (activeSessionId) return null;
	// 日常空间目录不是 git 仓库：隐藏分支选择器，只留归属 chip（可下拉切回项目）
	const daily = isDailyCwd(cwd);
	return (
		<div className="flex items-center justify-center gap-2 text-ui-13 text-ink-dim">
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
	const [adding, setAdding] = useState(false);
	const t = useT();
	const cwd = useSessionsStore(selectActiveCwd);
	const pickDirectory = useSessionsStore((s) => s.pickDirectory);
	const setDraftCwd = useSessionsStore((s) => s.setDraftCwd);
	const allSessions = useProjectsStore((s) => s.allSessions);
	const addedProjects = useProjectsStore((s) => s.addedProjects);
	const projects = useMemo(
		() => deriveProjects({ allSessions, addedProjects }),
		[allSessions, addedProjects],
	);
	const name = cwd ? pathLastSegment(cwd) : undefined;
	const daily = isDailyCwd(cwd);
	// 模块缓存（load() 已 await 初始化；空态 EmptyState 挂载即触发 load）
	const dailyDir = getDailyDirCached(cwd ? environmentEntityRef(cwd).environment : LOCAL_ENVIRONMENT);
	const remote = cwd ? environmentEntityRef(cwd).environment.kind === "ssh" : false;

	return (
		<>
			{adding && <AddProjectDialog onClose={() => setAdding(false)} onLocalProject={pickDirectory} />}
			<Dropdown
				trigger={
					<span className="flex items-center gap-1.5" data-project-picker>
						{daily ? t("projects.daily") : (name ?? t("projects.selectProject"))}
						{remote && (
							<RemoteEnvironmentIndicator
								environment={cwd ? environmentEntityRef(cwd).environment : LOCAL_ENVIRONMENT}
							/>
						)}
					</span>
				}
			>
				{(close) => (
					<>
						{/* 日常空间钉顶：新会话页可在 日常 ↔ 项目 间双向切换（与侧栏同一空间语义） */}
						{dailyDir && (
							<>
								<button
									type="button"
									className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-13 transition-colors hover:bg-hover ${
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
									{remote && (
										<RemoteEnvironmentIndicator
											environment={cwd ? environmentEntityRef(cwd).environment : LOCAL_ENVIRONMENT}
										/>
									)}
								</button>
								{projects.length > 0 && <div className="my-0.5 border-t border-border" />}
							</>
						)}
						{projects.map((project) => (
							<button
								key={project.cwd}
								type="button"
								className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-13 transition-colors hover:bg-hover ${
									project.cwd === cwd ? "text-ink" : "text-ink-2"
								}`}
								onClick={() => {
									// 写进 draft 配置（同时记住 lastCwd）：发送首条消息时即用这个目录创建
									setDraftCwd(project.cwd);
									close();
								}}
							>
								<span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded bg-ink-faint text-ui-10 font-semibold text-on-ink">
									{(project.name[0] ?? "P").toUpperCase()}
								</span>
								<span className="truncate">{project.name}</span>
								{environmentEntityRef(project.cwd).environment.kind === "ssh" && (
									<RemoteEnvironmentIndicator environment={environmentEntityRef(project.cwd).environment} />
								)}
							</button>
						))}
						<button
							type="button"
							className="mt-0.5 flex w-full items-center gap-2 rounded-md border-t border-border px-2 py-1.5 text-left text-ui-13 text-ink-dim transition-colors hover:bg-hover"
							onClick={() => {
								setAdding(true);
								close();
							}}
						>
							{t("projects.selectProject")}…
						</button>
					</>
				)}
			</Dropdown>
		</>
	);
}

function BranchPicker({ cwd }: { cwd: string | null }) {
	const t = useT();
	const [branches, setBranches] = useState<string[]>([]);
	const [current, setCurrent] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [revision, setRevision] = useState(0);
	const [changing, setChanging] = useState(false);
	const remoteStatus = useRemoteConnectionStore((state) => state.status);
	const remote = cwd ? environmentEntityRef(cwd).environment.kind === "ssh" : false;
	const online =
		!remote ||
		(remoteStatus.state === "connected" &&
			!!remoteStatus.environment &&
			!!cwd &&
			sameEnvironment(environmentEntityRef(cwd).environment, remoteStatus.environment));
	const instance = remote ? remoteStatus.instanceId : undefined;

	// biome-ignore lint/correctness/useExhaustiveDependencies: revision 是显式刷新，instance 是同址服务重启；两者均要求重新对账
	useEffect(() => {
		if (!cwd || !online) return;
		let cancelled = false;
		void getExecutionApi(cwd)
			.listGitBranches({ cwd })
			.then((result) => {
				if (cancelled) return;
				setBranches(result.branches);
				setCurrent(result.current);
				setError(null);
			})
			.catch((error) => {
				if (!cancelled) setError(error instanceof Error ? error.message : String(error));
			});
		return () => {
			cancelled = true;
		};
	}, [cwd, revision, online, instance]);

	if (error && !current)
		return (
			<span className="text-ui-11 text-err">
				{error}{" "}
				<button type="button" disabled={!online} onClick={() => setRevision((value) => value + 1)}>
					{t("projects.refreshGit")}
				</button>
			</span>
		);
	if (!cwd || !current) {
		return <span className="text-ink-faint">⎇ {t("projects.noGit")}</span>;
	}

	return (
		<>
			<Dropdown
				onOpen={() => setRevision((value) => value + 1)}
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
								disabled={changing || !online}
								type="button"
								className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-13 transition-colors hover:bg-hover ${
									branch === current ? "font-medium text-ink" : "text-ink-2"
								}`}
								onClick={() => {
									if (branch !== current && cwd && online && !changing) {
										setChanging(true);
										setError(null);
										void getExecutionApi(cwd)
											.checkoutBranch({ cwd, branch })
											.then(() => setRevision((value) => value + 1))
											.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
											.finally(() => setChanging(false));
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
			{error && <span className="text-ui-11 text-red-500">{error}</span>}
		</>
	);
}
