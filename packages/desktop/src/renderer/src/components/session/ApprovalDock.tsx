import type { PermissionRequest } from "@percho/shared";
import { useCallback, useEffect, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useTranscriptStore } from "../../stores/transcript";
import { WarningIcon } from "../icons";

/** 退出动画时长，与 globals.css 的 dock-exit（approval-exit）同步 */
const EXIT_MS = 150;

/**
 * 权限审批卡（与 Composer 同位互换；应答中 agent 阻塞，发消息无意义）。
 * 视觉已迁移到 error-system 无边框语言（extension-dialogs 画板⑥，2026-09 拍板）：
 * amber 三角 glyph 是唯一警示表达，四键全幽灵文字按钮（「允许一次」ink 加重），
 * 快捷键挪进左侧提示行；行为/通道/记忆逻辑不变（权限仍走 PermissionGate 直通道）。
 * 应答立即发给 backend（agent 尽快解锁），卡留 EXIT_MS 播退出动画；队列中下一个请求以 key 切换重放进入动画。
 */
export function ApprovalDock({ sessionId }: { sessionId: string | null }) {
	const t = useT();
	const pending = useTranscriptStore((s) =>
		sessionId ? s.bySession[sessionId]?.pendingPermissions : undefined,
	);
	const resolvePermission = useTranscriptStore((s) => s.resolvePermission);
	const request = pending?.[0] ?? null;
	const queueCount = (pending?.length ?? 1) - 1;

	// shown：正在显示（含退出动画中）的请求；request 消失后保留 EXIT_MS 播退出
	const [shown, setShown] = useState<PermissionRequest | null>(null);
	const [leaving, setLeaving] = useState(false);
	// 应答 IPC 失败：请求保留在 pending（agent 仍在等待），展示错误供重试（D3）
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	useEffect(() => {
		if (request) {
			setShown(request);
			setLeaving(false);
			return;
		}
		if (!shown) return;
		setLeaving(true);
		const timer = setTimeout(() => {
			setShown(null);
			setLeaving(false);
		}, EXIT_MS);
		return () => clearTimeout(timer);
	}, [request, shown]);

	// 应答链：await IPC 成功才移除 UI（失败保留请求，agent 不丢审批）；按钮与快捷键共用
	const respond = useCallback(
		async (answer: "allow" | "deny" | "allowAlways" | "allowDir") => {
			if (!shown || leaving || !sessionId || sending) return;
			setSending(true);
			setError(null);
			try {
				await getPi().respondPermission(shown.id, answer);
				resolvePermission(sessionId, shown.id);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setSending(false);
			}
		},
		[shown, leaving, sessionId, sending, resolvePermission],
	);

	// 键盘快捷键：Enter=允许一次，A=本项目总是允许，D=允许此目录（仅越界路径类有），Esc=拒绝
	useEffect(() => {
		if (!shown || leaving || !sessionId) return;
		const onKeyDown = (e: KeyboardEvent) => {
			const answer =
				e.key === "Enter"
					? "allow"
					: e.key === "Escape"
						? "deny"
						: e.key === "a" || e.key === "A"
							? "allowAlways"
							: (e.key === "d" || e.key === "D") && shown.suggestDir
								? "allowDir"
								: null;
			if (!answer) return;
			e.preventDefault();
			void respond(answer);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [shown, leaving, sessionId, respond]);

	if (!shown) return null;

	const hintParams = {
		allowOnce: t("permission.allowOnce"),
		always: t("permissionShort.always"),
		dir: t("permissionShort.dir"),
		deny: t("permission.deny"),
	};

	return (
		// z-20 同 DockSlot：审批卡在下方时缩略图 × 同样会伸出容器顶
		<div className="relative z-20 shrink-0 px-6 pb-3">
			<div className="mx-auto max-w-[760px]">
				<div
					key={shown.id}
					role="dialog"
					aria-modal
					className={`flex flex-col gap-2.5 rounded-[14px] bg-surface px-3.5 pt-3 pb-2.5 shadow-soft outline-none ${
						leaving ? "dock-exit" : "dock-in"
					}`}
				>
					<div className="flex min-h-5 items-center gap-2">
						<span className="flex-none text-warn" aria-hidden="true">
							<WarningIcon />
						</span>
						<h3 className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-ink-2">
							{shown.title}
						</h3>
						{queueCount > 0 && (
							<span className="shrink-0 text-[11px] text-ink-faint">
								{t("permission.queued", { count: queueCount })}
							</span>
						)}
					</div>
					<p className="max-h-32 overflow-y-auto rounded-lg bg-hover p-2.5 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap text-ink-2 select-text">
						{shown.message}
					</p>
					{error && (
						<p className="rounded-lg bg-hover px-2.5 py-1.5 text-[12px] break-all text-err">{error}</p>
					)}
					<div className="flex flex-wrap items-center gap-0.5">
						<span className="text-[11px] text-ink-faint">
							{shown.suggestDir
								? t("interaction.hintPermissionDir", hintParams)
								: t("interaction.hintPermission", hintParams)}
						</span>
						<div className="ml-auto flex flex-wrap items-center gap-0.5">
							<GhostAction onClick={() => respond("deny")}>{t("permission.deny")}</GhostAction>
							{shown.suggestDir && (
								<GhostAction onClick={() => respond("allowDir")}>{t("permission.allowDir")}</GhostAction>
							)}
							<GhostAction onClick={() => respond("allowAlways")}>{t("permission.allowAlways")}</GhostAction>
							<GhostAction strong onClick={() => respond("allow")}>
								{t("permission.allowOnce")}
							</GhostAction>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

/** 幽灵文字按钮（error-system 语言）：ink-faint，hover 才现底；主操作 ink 加重 */
function GhostAction({
	onClick,
	strong,
	children,
}: {
	onClick: () => void;
	strong?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`rounded-[7px] px-2.5 py-1 text-[12px] transition-colors hover:bg-hover ${
				strong ? "font-medium text-ink hover:text-ink" : "text-ink-faint hover:text-ink-2"
			}`}
		>
			{children}
		</button>
	);
}
