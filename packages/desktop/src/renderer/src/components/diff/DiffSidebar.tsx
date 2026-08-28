import { deriveTurnChanges, type TurnChanges } from "@percho/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { useTranscriptStore } from "../../stores/transcript";
import { useUiStore } from "../../stores/ui";
import { CloseIcon } from "../icons";
import { DiffFileCard } from "./DiffFileCard";

/** 空 turn 列表稳定引用（selector/useMemo 缺省，禁内联新数组） */
const EMPTY_TURNS: TurnChanges[] = [];

/**
 * 分支行：侧栏 header 下方一条幽灵文字行（⎇ 分支名），点击下弹本地分支列表。
 * 只读不可切换（空态 ProjectBranchPicker 才是切换入口，列表无 hover/click 态避免假交互）。
 * 原先是消息区左上角悬浮胶囊，被用户判为突兀后收进侧栏——分支与变更同域（仓库状态）。
 * 有消息内容才显示（新会话与输入框下方 ProjectBranchPicker 重复）；非 git 目录不渲染。
 */
function BranchRow() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const cwd = useSessionsStore((s) => s.cwd);
	const messages = useTranscriptStore((s) =>
		activeSessionId ? s.bySession[activeSessionId]?.messages : undefined,
	);
	const [branches, setBranches] = useState<string[]>([]);
	const [current, setCurrent] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const hasContent = !!messages && messages.length > 0;

	// cwd 变化（切会话/切项目）即刷新；展开时也重拉一次（分支可能在终端被切走）
	// biome-ignore lint/correctness/useExhaustiveDependencies: open 是有意触发源——展开时重拉一次（分支可能在终端被切走）
	useEffect(() => {
		if (!cwd || !hasContent) return;
		let cancelled = false;
		void getPi()
			.listGitBranches(cwd)
			.then((r) => {
				if (cancelled) return;
				setBranches(r.branches);
				setCurrent(r.current);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [cwd, hasContent, open]);

	// 点击外部关闭（Dropdown 同款）
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const hit = e.target instanceof Element ? e.target.closest("[data-branch-row]") : null;
			if (!hit) setOpen(false);
		};
		window.addEventListener("pointerdown", onPointerDown);
		return () => window.removeEventListener("pointerdown", onPointerDown);
	}, [open]);

	if (!hasContent || !cwd || !current || branches.length === 0) return null;

	return (
		<div className="diff-side-branch" data-branch-row>
			<button
				type="button"
				className="diff-branch-btn"
				aria-expanded={open}
				title={current}
				onClick={() => setOpen((v) => !v)}
			>
				<span aria-hidden="true">⎇</span>
				<span className="diff-branch-name">{current}</span>
			</button>
			{open && (
				<div className="diff-branch-pop">
					{branches.map((branch) => {
						const isCurrent = branch === current;
						return (
							<div key={branch} className={`diff-branch-item${isCurrent ? " on" : ""}`} title={branch}>
								<span aria-hidden="true" className="diff-branch-dot" />
								<span className="diff-branch-itemname">{branch}</span>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

/**
 * 右侧 diff 栏（push 式，宽度 0 ↔ 420px 过渡，聊天列自然压缩）。
 * 按轮次倒序分组（最近一轮在上）；分段开关「全部 / 最近一轮」；
 * chip 跳转 = stores/ui.ts 的 diffFocus → 这里直接操作 DOM（开卡片 + 滚动定位 + 闪烁）。
 * 开关状态内存态不持久化（重启统一关闭，用户已定）。
 */
export function DiffSidebar() {
	const t = useT();
	const open = useUiStore((s) => s.diffSidebarOpen);
	const setOpen = useUiStore((s) => s.setDiffSidebarOpen);
	const diffFocus = useUiStore((s) => s.diffFocus);
	const clearDiffFocus = useUiStore((s) => s.clearDiffFocus);
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const messages = useTranscriptStore((s) =>
		activeSessionId ? s.bySession[activeSessionId]?.messages : undefined,
	);
	const turnChanges = useMemo(() => (messages ? deriveTurnChanges(messages) : EMPTY_TURNS), [messages]);
	const [scope, setScope] = useState<"all" | "latest">("all");
	const visibleTurns = useMemo(
		() => (scope === "latest" ? turnChanges.slice(-1) : turnChanges),
		[turnChanges, scope],
	);
	// 展示倒序：最近一轮在上
	const groups = useMemo(() => [...visibleTurns].reverse(), [visibleTurns]);
	const totalFiles = visibleTurns.reduce((s, tc) => s + tc.files.length, 0);
	const totalAdded = visibleTurns.reduce((s, tc) => s + tc.totalAdded, 0);
	const totalRemoved = visibleTurns.reduce((s, tc) => s + tc.totalRemoved, 0);
	const bodyRef = useRef<HTMLDivElement>(null);

	// chip → 侧栏跳转：目标不在当前分段时先切「全部」（effect 随 visibleTurns 变化重跑），再定位
	useEffect(() => {
		if (!diffFocus) return;
		const inScope = visibleTurns.some((tc) =>
			tc.files.some((f) => f.sections.some((s) => s.toolCallKey === diffFocus.sectionKey)),
		);
		if (!inScope) {
			setScope("all");
			return;
		}
		const el = bodyRef.current?.querySelector(`[data-section-key="${CSS.escape(diffFocus.sectionKey)}"]`);
		const card = el?.closest("details.diff-file-card");
		if (card instanceof HTMLDetailsElement) {
			card.open = true;
			card.scrollIntoView({
				block: "center",
				behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
			});
			card.classList.remove("jump-flash");
			void card.offsetWidth; // reflow 重播动画
			card.classList.add("jump-flash");
			setTimeout(() => card.classList.remove("jump-flash"), 1200);
		}
		clearDiffFocus();
	}, [diffFocus, visibleTurns, clearDiffFocus]);

	return (
		<aside className={`diff-sidebar${open ? " open" : ""}`} aria-hidden={!open}>
			<div className="diff-sidebar-in">
				<div className="diff-side-head">
					<span className="diff-side-title">{t("diff.title")}</span>
					<span className="diff-side-sum">
						{t("diff.filesSummary", { count: totalFiles })} ·{" "}
						<span className="turn-diff-added">+{totalAdded}</span>{" "}
						<span className="turn-diff-removed">−{totalRemoved}</span>
					</span>
					<div className="diff-seg" role="tablist">
						<button type="button" className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>
							{t("diff.scopeAll")}
						</button>
						<button
							type="button"
							className={scope === "latest" ? "on" : ""}
							onClick={() => setScope("latest")}
						>
							{t("diff.scopeLatest")}
						</button>
					</div>
					<button
						type="button"
						className="diff-side-close"
						onClick={() => setOpen(false)}
						aria-label={t("common.close")}
					>
						<CloseIcon />
					</button>
				</div>
				<BranchRow />
				<div className="diff-side-scroll" ref={bodyRef}>
					{totalFiles === 0 ? (
						<div className="diff-side-empty">{t("diff.empty")}</div>
					) : (
						groups.map((tc, gi) => (
							<div className="diff-turn-group" key={tc.turnIndex}>
								<div className="diff-tg-head">
									<span className="diff-tg-title">{t("diff.turnLabel", { n: tc.turnIndex + 1 })}</span>
									<span className="diff-tg-sum">
										<span className="turn-diff-added">+{tc.totalAdded}</span>{" "}
										<span className="turn-diff-removed">−{tc.totalRemoved}</span>
									</span>
								</div>
								{tc.files.map((f, fi) => (
									<DiffFileCard
										key={`${tc.turnIndex}:${f.path}`}
										file={f}
										/* 默认只展开「最近一轮组的第一张卡」，其余收起 */
										defaultOpen={gi === 0 && fi === 0}
									/>
								))}
							</div>
						))
					)}
				</div>
			</div>
		</aside>
	);
}
