import type { SessionMeta } from "@percho/shared";
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { partitionSessionsByPin, useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { CloseIcon, PlusIcon } from "../icons";
import { SessionAvatar } from "./SessionAvatar";
import { sessionTitle, useSessionStatus } from "./session-status";

/**
 * 悬浮会话列表（设置 → 外观 → 会话列表位置「悬浮」）：对话页左上角贴边浮出的实色面板，
 * 由顶栏「项目」右侧的列表按钮开合（与顶栏胶囊互斥——悬浮模式下胶囊区整体收起）。
 * 定位 = 临时切换器：点行切换会话即收起；关闭 × / 新建 + 走与顶栏同一套 store 动作。
 * 视觉三层分离（定位壳 / 阴影层 / veil 背景层 / 内容层）见 globals.css 的 .float-list-* 段；
 * 退场 150ms 动画跑完才卸载（closing 相位 + onAnimationEnd），提前卸载会闪回（RenamePopover 同坑）。
 * 挂载点 = App.tsx 聊天列容器内（与 SessionRail 同级）：不能进 main，否则输入框高度变化会推挤面板。
 */
export function FloatingSessionList() {
	const t = useT();
	const mode = useUiPreferencesStore((s) => s.sessionListMode);
	const pinnedSessions = useUiPreferencesStore((s) => s.pinnedSessions);
	const open = useUiStore((s) => s.floatingListOpen);
	const setOpen = useUiStore((s) => s.setFloatingListOpen);
	const view = useUiStore((s) => s.view);
	const setView = useUiStore((s) => s.setView);
	const sessions = useSessionsStore((s) => s.sessions);
	const switchSession = useSessionsStore((s) => s.switchSession);
	const createDraftSession = useSessionsStore((s) => s.createDraftSession);
	/** DOM 相位：null = 未挂载；open 翻 false 先播退场动画，跑完（onAnimationEnd）才卸载 */
	const [phase, setPhase] = useState<"in" | "out" | null>(null);

	useEffect(() => {
		setPhase((prev) => (open ? "in" : prev === null ? null : "out"));
	}, [open]);

	// 归位：退出悬浮模式 / 离开对话视图 / 会话清空 —— 内存态一并收起，避免下次切回悬浮时残留展开的面板
	useEffect(() => {
		if (mode !== "floating" || view !== "chat" || sessions.length === 0) setOpen(false);
	}, [mode, view, sessions.length, setOpen]);

	// 点面板外 / Esc 收起。pointerdown 用捕获阶段（与 ContextMenu 一致）；顶栏触发按钮自己负责开合，
	// 这里排除掉它——否则同一次点击会「先收起再开」（stale 的 open 判断打起来）
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Element | null;
			if (target?.closest("[data-floating-list]") || target?.closest("[data-floating-list-trigger]")) return;
			setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, [open, setOpen]);

	// 模式切回顶栏：整块直接撤掉（面板在设置弹窗后面，不需要退场动画）
	if (phase === null || mode !== "floating") return null;
	// 展示顺序 = 顶栏同款（置顶分区在左 + 数组序）；面板内不做拖拽排序（排序仍回顶栏操作）
	const ordered = partitionSessionsByPin(sessions, pinnedSessions);

	return (
		<div
			data-floating-list=""
			className={`absolute left-1.5 top-0.5 z-30 w-[220px] ${phase === "out" ? "fl-out" : "fl-in"}`}
			// 只认自己的动画结束：行里头像的呼吸动画（tab-avatar-working）会冒泡上来
			onAnimationEnd={(e) => {
				if (e.target === e.currentTarget && phase === "out") setPhase(null);
			}}
		>
			<div className="float-list-shadow">
				<div className="float-list-veil" />
			</div>
			<div className="relative px-2 pb-[26px] pt-5">
				<div className="flex items-center justify-between px-3.5 pb-2">
					<span className="text-[11px] tracking-[0.06em] text-ink-faint">
						{t("floatingList.title")} · {ordered.length}
					</span>
					<button
						type="button"
						className="flex h-5 w-5 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
						onClick={() => {
							createDraftSession();
							setView("chat");
							setOpen(false);
						}}
						aria-label={t("tabbar.newSession")}
					>
						<PlusIcon size={13} />
					</button>
				</div>
				<div className="float-list-scroll max-h-[380px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
					{ordered.map((session) => (
						<FloatingRow
							key={session.sessionId}
							session={session}
							onSelect={() => {
								switchSession(session.sessionId);
								setView("chat");
								setOpen(false);
							}}
							onClose={() => void useSessionsStore.getState().closeSession(session.sessionId)}
						/>
					))}
				</div>
			</div>
		</div>
	);
}

/** 单行会话：行本体 = 切换按钮；行尾 ×（仅 hover / 键盘聚焦该行时浮现）是内层 span——
 *  外层已是 button，嵌 button 是非法结构，stopPropagation 防顺带切换（与顶栏胶囊/轨道同款） */
function FloatingRow({
	session,
	onSelect,
	onClose,
}: {
	session: SessionMeta;
	onSelect: () => void;
	onClose: () => void;
}) {
	const t = useT();
	const status = useSessionStatus(session.sessionId);
	// 只订阅原始值（boolean），列表多行也不随流式 delta 级联重渲染
	const isActive = useSessionsStore((s) => s.activeSessionId) === session.sessionId;
	return (
		<button
			type="button"
			aria-current={isActive ? "true" : undefined}
			className={`float-item relative flex w-full items-center gap-[9px] px-3.5 py-[5px] text-left text-[13px] ${
				isActive ? "font-medium text-ink" : "text-ink-faint hover:text-ink-2"
			}`}
			onClick={onSelect}
		>
			<SessionAvatar session={session} status={status} isActive={isActive} size={18} />
			<span className="min-w-0 flex-1 truncate">
				{sessionTitle(session, t("tabbar.untitled"), t("projects.daily"))}
			</span>
			<span
				className="float-item-close absolute right-3 flex h-4 w-4 items-center justify-center rounded text-ink-dim hover:text-ink"
				aria-hidden="true"
				onClick={(e) => {
					e.stopPropagation();
					onClose();
				}}
			>
				<CloseIcon />
			</span>
		</button>
	);
}
