import type { PermissionRequest } from "@pi-desktop/shared";
import { useEffect, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useTranscriptStore } from "../../stores/transcript";
import { Composer } from "../composer/Composer";
import { Button } from "../ui/Button";

/** 退出动画时长，与 globals.css 的 approval-exit 同步 */
const EXIT_MS = 150;

/**
 * 底部交换槽：权限审批面板与 Composer 同位互换（审批中 agent 阻塞，发消息无意义）。
 * 应答立即发给 backend（agent 尽快解锁），面板留 EXIT_MS 播退出动画；
 * 队列中下一个请求以 key 切换重放进入动画。
 */
export function ApprovalDock({
	sessionId,
	hideComposer,
}: {
	sessionId: string | null;
	hideComposer: boolean;
}) {
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

	const respond = (answer: "allow" | "deny" | "allowAlways") => {
		if (!shown || leaving || !sessionId) return;
		void getPi().respondPermission(shown.id, answer);
		resolvePermission(sessionId, shown.id);
	};

	// 键盘快捷键：Enter=允许一次，A=本会话总是允许，Esc=拒绝（输入框已隐藏，无冲突）
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
							: null;
			if (!answer) return;
			e.preventDefault();
			void getPi().respondPermission(shown.id, answer);
			resolvePermission(sessionId, shown.id);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [shown, leaving, sessionId, resolvePermission]);

	if (!shown) {
		return hideComposer ? null : (
			<div className="approval-composer-enter">
				<Composer />
			</div>
		);
	}

	return (
		<div className="shrink-0 px-6 pb-3">
			<div className="mx-auto max-w-[760px]">
				<div
					key={shown.id}
					className={`rounded-2xl border-[0.5px] border-border border-l-2 border-l-amber-400 bg-surface px-4 py-3 shadow-[0_0_14px_-2px_rgba(24,24,27,0.08)] ${
						leaving ? "approval-exit" : "approval-enter"
					}`}
					role="dialog"
					aria-modal
				>
					<div className="flex items-center gap-2">
						<span className="text-amber-500" aria-hidden="true">
							⚠
						</span>
						<h3 className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-ink">
							{shown.title}
						</h3>
						{queueCount > 0 && (
							<span className="shrink-0 text-[11px] text-ink-faint">
								{t("permission.queued", { count: queueCount })}
							</span>
						)}
					</div>
					<p className="mt-2 max-h-32 overflow-y-auto rounded-lg bg-hover p-2.5 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap text-ink-2 select-text">
						{shown.message}
					</p>
					<div className="mt-3 flex items-center justify-end gap-2">
						<Button onClick={() => respond("deny")}>
							{t("permission.deny")}
							<kbd className="ml-1.5 rounded bg-hover px-1 py-0.5 text-[10px] text-ink-faint">Esc</kbd>
						</Button>
						<Button onClick={() => respond("allowAlways")}>
							{t("permission.allowAlways")}
							<kbd className="ml-1.5 rounded bg-hover px-1 py-0.5 text-[10px] text-ink-faint">A</kbd>
						</Button>
						<Button variant="primary" onClick={() => respond("allow")}>
							{t("permission.allowOnce")}
							<kbd className="ml-1.5 rounded bg-on-ink/15 px-1 py-0.5 text-[10px] text-on-ink/80">Enter</kbd>
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
