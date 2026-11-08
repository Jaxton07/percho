import type { SessionMeta } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { getExecutionApi } from "../../environment-api";
import { useT } from "../../i18n";
import type { SidebarProjectEntry } from "../../lib/sidebar-groups";
import { PlusIcon } from "../icons";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { AddProjectDialog } from "./AddProjectDialog";
import { SidebarGroup } from "./SidebarGroup";
import type { SidebarBatching } from "./useSidebarBatching";

/**
 * 「项目」小标 + 项目分组列表：**v7 起只是一个固定标题分割区，不可折叠**（用户：大栏折叠意义不大）；
 * 右侧常显一个「＋」添加项目（不藏在 hover 里，也不占列表底部）。
 * `batching` 原样过给每个分组（分批显示 + 搜索临时态），本组件不解读它。
 */
export function ProjectSection({
	projects,
	activeSessionId,
	batching,
	onTogglePin,
	onRemoveProject,
	activeCwd,
	visible = true,
	paging,
}: {
	projects: SidebarProjectEntry[];
	activeSessionId: string | null;
	batching: SidebarBatching;
	onTogglePin: (cwd: string) => void;
	onRemoveProject: (cwd: string, token: string) => Promise<void>;
	activeCwd?: string | null;
	visible?: boolean;
	paging?: {
		search: string;
		verified: SessionMeta[];
		pinnedSessions: readonly string[];
		known: readonly SessionMeta[];
	};
}) {
	const t = useT();
	const [adding, setAdding] = useState(false);
	const [preview, setPreview] = useState<{
		cwd: string;
		label: string;
		token: string;
		sessionCount: number;
		archivedCount: number;
	} | null>(null);
	const [error, setError] = useState<{ cwd: string; label: string } | null>(null);
	const generation = useRef(0);
	const cancelPending = useRef<() => void>(() => {});
	const projectCwds = useRef(new Set(projects.map((project) => project.cwd)));
	projectCwds.current = new Set(projects.map((project) => project.cwd));
	const context = useRef({ activeSessionId, activeCwd, visible });
	if (
		context.current.activeSessionId !== activeSessionId ||
		context.current.activeCwd !== activeCwd ||
		context.current.visible !== visible
	) {
		generation.current++;
		context.current = { activeSessionId, activeCwd, visible };
	}
	// Context changes invalidate the confirmation even when the new values are not otherwise used here.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset confirmation on navigation or visibility changes
	useEffect(() => {
		setPreview(null);
		setError(null);
	}, [activeSessionId, activeCwd, visible]);
	useEffect(
		() => () => {
			generation.current++;
			cancelPending.current();
		},
		[],
	);
	const startPreview = (cwd: string, label: string) => {
		cancelPending.current();
		const current = ++generation.current;
		setPreview(null);
		setError(null);
		// A later interaction cancels the pending intent, including opening another menu.
		const cleanup = () => {
			window.removeEventListener("pointerdown", cancel, true);
			window.removeEventListener("keydown", cancel, true);
		};
		const cancel = () => {
			if (generation.current === current) generation.current++;
			cleanup();
		};
		cancelPending.current = cancel;
		window.addEventListener("pointerdown", cancel, { capture: true });
		window.addEventListener("keydown", cancel, { capture: true });
		void Promise.resolve()
			.then(() => getExecutionApi(cwd).previewSessionProjectDeletion({ cwd }))
			.then((result) => {
				if (
					!result.token ||
					!Number.isSafeInteger(result.sessionCount) ||
					!Number.isSafeInteger(result.archivedCount) ||
					result.archivedCount < 0 ||
					result.sessionCount < result.archivedCount
				)
					throw new Error("Invalid project deletion preview");
				if (generation.current === current && projectCwds.current.has(cwd))
					setPreview({ ...result, cwd, label });
			})
			.catch(() => {
				if (generation.current === current) setError({ cwd, label });
			})
			.finally(cleanup);
	};
	return (
		<div>
			{adding && <AddProjectDialog onClose={() => setAdding(false)} />}
			{visible && preview && (
				<ConfirmDialog
					danger
					title={t("sidebar.removeProjectTitle", { name: preview.label })}
					description={t("sidebar.removeProjectDesc", {
						count: preview.sessionCount - preview.archivedCount,
						archived: preview.archivedCount,
					})}
					confirmLabel={t("sidebar.removeProject")}
					cancelLabel={t("common.cancel")}
					onCancel={() => setPreview(null)}
					onConfirm={() => {
						const current = ++generation.current;
						setPreview(null);
						void onRemoveProject(preview.cwd, preview.token).catch(() => {
							if (generation.current === current) setError({ cwd: preview.cwd, label: preview.label });
						});
					}}
				/>
			)}
			{visible && error && (
				<button
					type="button"
					className="px-1.5 text-ui-12 text-ink-faint hover:text-ink-2"
					onClick={() => startPreview(error.cwd, error.label)}
				>
					{t("sidebar.removeProjectRetry", { name: error.label })}
				</button>
			)}
			<div className="group/sect mt-2 flex h-8 items-center gap-[5px] rounded-[7px] px-[6px] text-ui-15 font-medium text-ink-dim">
				<span className="min-w-0 flex-1 truncate">{t("sidebar.projectsSection")}</span>
				<button
					type="button"
					aria-label={t("sidebar.addProject")}
					className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-ink-dim transition-colors hover:bg-hover hover:text-ink"
					onClick={() => setAdding(true)}
				>
					<PlusIcon size={15} />
				</button>
			</div>
			{projects.map((project) => (
				<SidebarGroup
					key={project.cwd}
					group={project}
					activeSessionId={activeSessionId}
					pinned={project.pinned}
					totalSessions={project.totalSessions}
					batching={batching}
					paging={paging}
					onTogglePin={onTogglePin}
					onRemove={() => startPreview(project.cwd, project.label ?? project.cwd)}
				/>
			))}
		</div>
	);
}
