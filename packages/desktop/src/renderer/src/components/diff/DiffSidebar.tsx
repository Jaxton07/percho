import { deriveTurnChanges, environmentEntityRef, sameEnvironment, type TurnChanges } from "@percho/shared";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getExecutionApi } from "../../environment-api";
import { useT } from "../../i18n";
import { selectActiveCwd } from "../../lib/active-cwd";
import { clearSelectionWithin } from "../../lib/clear-selection-within";
import { diffFileViewKey } from "../../lib/session-view-keys";
import { transitionMilliseconds, useExitPresence } from "../../lib/use-exit-presence";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { useSessionViewStore } from "../../stores/session-view";
import { useSessionsStore } from "../../stores/sessions";
import { useTranscriptStore } from "../../stores/transcript";
import { useUiStore } from "../../stores/ui";
import { CloseIcon } from "../icons";
import { SessionViewContext } from "../ui/DeferredDetails";
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
	const cwd = useSessionsStore(selectActiveCwd);
	return <BranchRowForDirectory key={cwd ?? "none"} cwd={cwd} />;
}
function BranchRowForDirectory({ cwd }: { cwd: string | null }) {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const messages = useTranscriptStore((s) =>
		activeSessionId ? s.bySession[activeSessionId]?.messages : undefined,
	);
	const [branches, setBranches] = useState<string[]>([]);
	const [current, setCurrent] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const status = useRemoteConnectionStore((state) => state.status);
	const online =
		!cwd ||
		environmentEntityRef(cwd).environment.kind === "local" ||
		(status.state === "connected" &&
			!!status.environment &&
			sameEnvironment(environmentEntityRef(cwd).environment, status.environment));
	const instance =
		cwd && environmentEntityRef(cwd).environment.kind === "ssh" ? status.instanceId : undefined;
	const hasContent = !!messages && messages.length > 0;

	// cwd 变化（切会话/切项目）即刷新；展开时也重拉一次（分支可能在终端被切走）
	// biome-ignore lint/correctness/useExhaustiveDependencies: open 是有意触发源——展开时重拉一次（分支可能在终端被切走）
	useEffect(() => {
		if (!cwd || !hasContent || !online) return;
		let cancelled = false;
		void getExecutionApi(cwd)
			.listGitBranches({ cwd })
			.then((r) => {
				if (cancelled) return;
				setBranches(r.branches);
				setCurrent(r.current);
				setError(null);
			})
			.catch((error) => {
				if (!cancelled) setError(error instanceof Error ? error.message : String(error));
			});
		return () => {
			cancelled = true;
		};
	}, [cwd, activeSessionId, hasContent, open, online, instance]);

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

	if (!hasContent || !cwd) return null;
	if (error) return <p className="px-3 text-ui-11 text-err">{error}</p>;
	if (!current || branches.length === 0) return null;

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
 * 右侧 diff 浮层抽屉：固定宽度、transform 进退，不参与聊天列布局。
 * 关闭只走顶栏按钮 / 面板关闭按钮 / Esc；点击聊天区不收起，便于对照消息与变更。
 * 按轮次倒序分组（最近一轮在上）；分段开关「全部 / 最近一轮」；
 * chip 跳转 = stores/ui.ts 的 diffFocus → 这里直接操作 DOM（开卡片 + 滚动定位 + 闪烁）。
 * 开关状态内存态不持久化（重启统一关闭，用户已定）。
 */
export function DiffSidebar() {
	const open = useUiStore((s) => s.diffSidebarOpen);
	const sessionId = useSessionsStore((s) => s.activeSessionId);
	const ref = useRef<HTMLElement>(null);
	const present = useExitPresence(open, ref, "transform");
	const owner = useRef(sessionId);
	if (open) owner.current = sessionId;
	useLayoutEffect(() => {
		if (!open && ref.current) clearSelectionWithin(ref.current);
		if (!open && ref.current?.contains(document.activeElement))
			document.querySelector<HTMLButtonElement>("[data-diff-toggle]")?.focus({ preventScroll: true });
	}, [open]);
	return (
		<aside ref={ref} className={`diff-sidebar${open ? " open" : ""}`} aria-hidden={!open} inert={!open}>
			{present && owner.current === sessionId && (
				<SessionViewContext.Provider value={owner.current}>
					<DiffSidebarContent key={owner.current ?? "draft"} sessionId={owner.current} />
				</SessionViewContext.Provider>
			)}
		</aside>
	);
}

function DiffSidebarContent({ sessionId }: { sessionId: string | null }) {
	const t = useT();
	const open = useUiStore((s) => s.diffSidebarOpen);
	const setOpen = useUiStore((s) => s.setDiffSidebarOpen);
	const diffFocus = useUiStore((s) => s.diffFocus);
	const clearDiffFocus = useUiStore((s) => s.clearDiffFocus);
	const sessionCwd = useSessionsStore(
		(s) => s.sessions.find((item) => item.sessionId === sessionId)?.cwd ?? null,
	);
	const messages = useTranscriptStore((s) => (sessionId ? s.bySession[sessionId]?.messages : undefined));
	const generation = useTranscriptStore((s) =>
		sessionId
			? `${s.bySession[sessionId]?.history?.generation ?? ""}:${s.bySession[sessionId]?.baselineRevision ?? 0}`
			: "",
	);
	const turnChanges = useMemo(() => (messages ? deriveTurnChanges(messages) : EMPTY_TURNS), [messages]);
	const [draftScope, setDraftScope] = useState<"all" | "latest">("all");
	const savedScope = useSessionViewStore((s) => (sessionId ? s.bySession[sessionId]?.scope : undefined));
	const scope = savedScope ?? draftScope;
	const setScope = useCallback(
		(value: "all" | "latest") =>
			sessionId ? useSessionViewStore.getState().setScope(sessionId, value) : setDraftScope(value),
		[sessionId],
	);
	const details = useSessionViewStore((s) => (sessionId ? s.bySession[sessionId]?.details : undefined));
	const visibleTurns = useMemo(
		() => (scope === "latest" ? turnChanges.slice(-1) : turnChanges),
		[turnChanges, scope],
	);
	const groups = useMemo(() => [...visibleTurns].reverse(), [visibleTurns]);
	const totalFiles = visibleTurns.reduce((n, t) => n + t.files.length, 0);
	const totalAdded = visibleTurns.reduce((n, t) => n + t.totalAdded, 0);
	const totalRemoved = visibleTurns.reduce((n, t) => n + t.totalRemoved, 0);
	const bodyRef = useRef<HTMLDivElement>(null);
	const intent = useRef(0);
	const pending = useRef<{ focus: typeof diffFocus; deadline: number; generation: typeof generation } | null>(
		null,
	);
	const flash = useRef<{ element: HTMLElement; timer: number } | null>(null);
	const restoreFrame = useRef(0);
	const restoring = useRef(false);
	const currentSource = useRef({ messages, generation });
	currentSource.current = { messages, generation };
	const captureAnchor = useCallback(() => {
		if (!sessionId) return;
		if (restoring.current) return;
		const scroller = bodyRef.current;
		if (!scroller) return;
		const top = scroller.getBoundingClientRect().top;
		const card = [...scroller.querySelectorAll<HTMLElement>("[data-view-key]")].find(
			(element) => element.getBoundingClientRect().bottom > top,
		);
		const key = card?.dataset.viewKey;
		if (key)
			useSessionViewStore.getState().setAnchor(sessionId, {
				key,
				offset: card.getBoundingClientRect().top - top,
				scrollTop: scroller.scrollTop,
			});
	}, [sessionId]);
	const cancelIntent = useCallback(() => {
		intent.current++;
		restoring.current = false;
		cancelAnimationFrame(restoreFrame.current);
		if (useUiStore.getState().diffFocus) clearDiffFocus();
	}, [clearDiffFocus]);
	useEffect(
		() => () => {
			if (flash.current) {
				clearTimeout(flash.current.timer);
				flash.current.element.classList.remove("jump-flash");
				flash.current = null;
			}
		},
		[],
	);
	useEffect(() => {
		if (!open) return;
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [open, setOpen]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 同一会话的基线换代也必须作废旧恢复
	useLayoutEffect(() => {
		if (!open) {
			captureAnchor();
			intent.current++;
			return;
		}
		if (useUiStore.getState().diffFocus) return;
		if (!sessionId) return;
		const anchor = useSessionViewStore.getState().bySession[sessionId]?.anchor;
		if (!anchor) return;
		const token = intent.current;
		let valid = true;
		const restore = () => {
			if (!valid || token !== intent.current || useUiStore.getState().diffFocus) return null;
			const scroller = bodyRef.current;
			const card = scroller?.querySelector<HTMLElement>(`[data-view-key="${CSS.escape(anchor.key)}"]`);
			if (scroller && card)
				scroller.scrollTop +=
					card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
			return card;
		};
		restoring.current = true;
		const card = restore();
		// 分组入场含 scale/translate，首次布局的 rect 不是最终位置；只在该有限动画期间跟随锚点。
		const motions = [
			...(card?.closest(".diff-turn-group")?.getAnimations?.() ?? []),
			...(card?.getAnimations?.() ?? []),
		].filter((animation) => {
			const effect = animation.effect;
			return (
				effect instanceof KeyframeEffect &&
				Number.isFinite(Number(effect.getComputedTiming().endTime)) &&
				effect
					.getKeyframes()
					.some(
						(frame) => "transform" in frame || "translate" in frame || "scale" in frame || "height" in frame,
					)
			);
		});
		const follow = () => {
			if (!restore()) {
				restoring.current = false;
				return;
			}
			if (motions.some((animation) => animation.playState === "running" || animation.pending))
				restoreFrame.current = requestAnimationFrame(follow);
			else {
				restoring.current = false;
				captureAnchor();
			}
		};
		restoreFrame.current = requestAnimationFrame(follow);
		return () => {
			valid = false;
			restoring.current = false;
			cancelAnimationFrame(restoreFrame.current);
		};
	}, [open, sessionId, generation, captureAnchor]);
	useLayoutEffect(() => {
		if (!diffFocus) return;
		const focus = diffFocus;
		const clear = () => {
			if (useUiStore.getState().diffFocus === focus) clearDiffFocus();
		};
		if (!open || !sessionId || (focus.sessionId && focus.sessionId !== sessionId)) {
			clear();
			return;
		}
		if (pending.current?.focus !== focus) {
			intent.current++;
			restoring.current = false;
			cancelAnimationFrame(restoreFrame.current);
			pending.current = { focus, deadline: 0, generation };
		}
		if (pending.current.generation !== generation) {
			clear();
			return;
		}
		const owner = turnChanges
			.flatMap((turn) => turn.files.map((file) => ({ turn, file })))
			.find(({ file }) => file.sections.some((section) => section.toolCallKey === focus.sectionKey));
		if (!owner) {
			clear();
			return;
		}
		const key = diffFileViewKey(owner.turn, owner.file);
		if (scope === "latest" && !visibleTurns.includes(owner.turn)) {
			setScope("all");
			return;
		}
		if (!details?.[key]) {
			useSessionViewStore.getState().setDetail(sessionId, key, true);
			return;
		}
		let valid = true;
		const token = intent.current,
			version = generation;
		let timer = 0;
		const finish = () => {
			if (
				!valid ||
				token !== intent.current ||
				version !== currentSource.current.generation ||
				useUiStore.getState().diffFocus !== focus ||
				!useUiStore.getState().diffSidebarOpen
			)
				return;
			const target = bodyRef.current?.querySelector<HTMLElement>(
				`[data-section-key="${CSS.escape(focus.sectionKey)}"]`,
			);
			const card = target?.closest("details.diff-file-card");
			if (!target || !(card instanceof HTMLDetailsElement) || !card.open) {
				clear();
				return;
			}
			target.scrollIntoView({
				block: "center",
				behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
			});
			if (flash.current) {
				clearTimeout(flash.current.timer);
				flash.current.element.classList.remove("jump-flash");
			}
			card.classList.remove("jump-flash");
			void card.offsetWidth;
			card.classList.add("jump-flash");
			flash.current = {
				element: card,
				timer: window.setTimeout(() => {
					card.classList.remove("jump-flash");
					flash.current = null;
				}, 1200),
			};
			clear();
		};
		const frame = requestAnimationFrame(() => {
			const card = bodyRef.current?.querySelector<HTMLElement>(`[data-view-key="${CSS.escape(key)}"]`);
			if (!card) {
				clear();
				return;
			}
			const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches
				? 0
				: transitionMilliseconds(getComputedStyle(card, "::details-content"), "height");
			if (pending.current?.focus !== focus) return;
			if (!pending.current.deadline) pending.current.deadline = performance.now() + duration + 16;
			timer = window.setTimeout(finish, Math.max(0, pending.current.deadline - performance.now()));
		});
		return () => {
			valid = false;
			cancelAnimationFrame(frame);
			clearTimeout(timer);
		};
	}, [
		diffFocus,
		open,
		scope,
		turnChanges,
		visibleTurns,
		details,
		sessionId,
		generation,
		clearDiffFocus,
		setScope,
	]);
	return (
		<div className="diff-sidebar-in">
			<div className="diff-side-head">
				<span className="diff-side-title">{t("diff.title")}</span>
				<span className="diff-side-sum">
					{t("diff.filesSummary", { count: totalFiles })} ·{" "}
					<span className="turn-diff-added">+{totalAdded}</span>{" "}
					<span className="turn-diff-removed">−{totalRemoved}</span>
				</span>
				<div className="diff-seg" role="tablist">
					<button
						type="button"
						className={scope === "all" ? "on" : ""}
						onClick={() => {
							cancelIntent();
							setScope("all");
						}}
					>
						{t("diff.scopeAll")}
					</button>
					<button
						type="button"
						className={scope === "latest" ? "on" : ""}
						onClick={() => {
							cancelIntent();
							setScope("latest");
						}}
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
			{/* biome-ignore lint/a11y/noStaticElementInteractions: 监听滚动及子项的已有手势取消迟到恢复，不新增容器操作 */}
			<div
				className="diff-side-scroll"
				ref={bodyRef}
				data-diff-scroll-root=""
				onScroll={captureAnchor}
				onWheel={cancelIntent}
				onPointerDownCapture={cancelIntent}
				onClickCapture={cancelIntent}
				onKeyDown={(event) => {
					if (
						["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Tab", "Enter"].includes(
							event.key,
						)
					)
						cancelIntent();
				}}
			>
				{totalFiles === 0 ? (
					<div className="diff-side-empty">{t("diff.empty")}</div>
				) : (
					groups.map((tc, gi) => (
						<div className="diff-turn-group" key={tc.turnId ?? tc.turnIndex}>
							<div className="diff-tg-head">
								<span className="diff-tg-title">{t("diff.turnLabel", { n: tc.turnIndex + 1 })}</span>
								<span className="diff-tg-sum">
									<span className="turn-diff-added">+{tc.totalAdded}</span>{" "}
									<span className="turn-diff-removed">−{tc.totalRemoved}</span>
								</span>
							</div>
							{tc.files.map((f, fi) => (
								<DiffFileCard
									key={diffFileViewKey(tc, f)}
									viewKey={diffFileViewKey(tc, f)}
									file={f}
									cwd={sessionCwd}
									/* 默认只展开「最近一轮组的第一张卡」，其余收起 */
									defaultOpen={gi === 0 && fi === 0}
								/>
							))}
						</div>
					))
				)}
			</div>
		</div>
	);
}
