import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { useLanStore } from "../store";
import { ArrowUpIcon, StopIcon } from "./icons";

/**
 * 远程输入区（M2）：remoteControl 开启时才由 App 渲染。
 * 发送：agent 运行中由后端 followUp 排队（发送即“已受理/已入队”回执）。
 * 停止：运行中才可用。readOnly（subagent 产物）会话整区禁用。
 * UX v2：悬浮毛玻璃条（24px 圆角 + blur）+ 圆形 SVG 按钮（发送=bg-ink 黑白，停止=红）。
 */
export function Composer({ sessionId }: { sessionId: string }) {
	const sendPrompt = useLanStore((s) => s.sendPrompt);
	const abortSession = useLanStore((s) => s.abortSession);
	const agentActive = useLanStore((s) => s.views[sessionId]?.agentActive ?? false);
	/** 会话未在桌面打开（无视图）→ 不能远程发消息（prompt 会 404），给提示 */
	const hasView = useLanStore((s) => Boolean(s.views[sessionId]));
	const readOnly = useLanStore((s) => s.list.find((item) => item.sessionId === sessionId)?.readOnly ?? false);
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const areaRef = useRef<HTMLTextAreaElement>(null);
	const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (noticeTimer.current) clearTimeout(noticeTimer.current);
		};
	}, []);

	const showNotice = (message: string) => {
		setNotice(message);
		if (noticeTimer.current) clearTimeout(noticeTimer.current);
		noticeTimer.current = setTimeout(() => setNotice(null), 3000);
	};

	/** 服务端错误串 → 本地化提示（已知错误映射，未知原文显示）。 */
	const showError = (error: string) => {
		if (error.includes("remote control disabled")) return showNotice(t("composer.disabled"));
		if (error.includes("read-only")) return showNotice(t("composer.readonly"));
		if (error === "network error") return showNotice(t("toast.failed"));
		showNotice(error);
	};

	const autoGrow = () => {
		const el = areaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
	};

	const send = async () => {
		const value = text.trim();
		if (!value || sending || readOnly) return;
		setSending(true);
		const wasActive = agentActive;
		const error = await sendPrompt(sessionId, value);
		setSending(false);
		if (error) {
			showError(error);
			return;
		}
		setText("");
		requestAnimationFrame(autoGrow);
		if (wasActive) showNotice(t("composer.queued"));
	};

	const abort = async () => {
		const error = await abortSession(sessionId);
		if (error) showError(error);
	};

	if (readOnly || !hasView) {
		return (
			<div className="composer-zone">
				<div className="composer-readonly">{readOnly ? t("composer.readonly") : t("composer.closed")}</div>
			</div>
		);
	}

	const canSend = !sending && Boolean(text.trim());
	return (
		<div className="composer-zone">
			{notice && <div className="queue-hint">{notice}</div>}
			<div className="composer-bar">
				<textarea
					ref={areaRef}
					className="composer-input"
					rows={1}
					placeholder={t("composer.placeholder")}
					value={text}
					disabled={sending}
					onChange={(e) => {
						setText(e.target.value);
						autoGrow();
					}}
					onKeyDown={(e) => {
						// Enter 发送、Shift+Enter 换行（移动端输入法合成期不触发）
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							void send();
						}
					}}
				/>
				{agentActive ? (
					<button
						type="button"
						className="c-btn stop"
						onClick={() => void abort()}
						aria-label={t("composer.stop")}
					>
						<StopIcon size={15} />
					</button>
				) : null}
				<button
					type="button"
					className={`c-btn send${canSend ? "" : " off"}`}
					disabled={!canSend}
					onClick={() => void send()}
					aria-label={t("composer.send")}
				>
					<ArrowUpIcon size={16} />
				</button>
			</div>
		</div>
	);
}
