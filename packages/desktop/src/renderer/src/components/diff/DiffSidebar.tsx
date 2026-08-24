import { deriveTurnChanges, type TurnChanges } from "@percho/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { useTranscriptStore } from "../../stores/transcript";
import { useUiStore } from "../../stores/ui";
import { CloseIcon } from "../icons";
import { DiffFileCard } from "./DiffFileCard";

/** 空 turn 列表稳定引用（selector/useMemo 缺省，禁内联新数组） */
const EMPTY_TURNS: TurnChanges[] = [];

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
