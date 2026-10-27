import type { UiError } from "@percho/shared";
import { useMemo, useState } from "react";
import { getExecutionApi } from "../../environment-api";
import { type MessageKey, useT } from "../../i18n";
import { canRetryError } from "../../lib/error-retry";
import { retryFailedTurn } from "../../stores/session-retry";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useTranscriptStore } from "../../stores/transcript";
import { ChevronRightIcon, CopyIcon, ErrorCircleIcon, GearIcon, RefreshIcon } from "../icons";

/**
 * 会话内错误条（error-system 画板 ①②③）：无边框悬浮卡片 + severity 一枚 glyph + 幽灵动作。
 * v2 语言：rounded-xl bg-surface shadow-soft（QueueBar/TodoPanel 同款），默认折叠。
 *
 * 动作行：
 * - retry：仅重试当前末端失败响应，不新增用户消息；旧卡保留详情但不能再次执行；
 * - compact：/compact 压缩（只 llmOverflow 类出现）；
 * - openSettings：打开设置面板（只凭证类出现）；
 * - copyDetail：复制原始报错（有 detail 时恒有）。
 */
export function ErrorNote({
	sessionId,
	cardId,
	error,
}: {
	sessionId: string | null;
	cardId: string;
	error: UiError;
}) {
	const t = useT();
	const [copied, setCopied] = useState(false);

	const retryAvailable = useTranscriptStore((s) =>
		sessionId ? canRetryError(s.bySession[sessionId], cardId) : false,
	);
	const readOnly = useSessionsStore(
		(s) => s.sessions.find((session) => session.sessionId === sessionId)?.readOnly === true,
	);

	const copyDetail = async () => {
		if (!error.detail) return;
		try {
			await navigator.clipboard.writeText(error.detail);
			setCopied(true);
			setTimeout(() => setCopied(false), 1800);
		} catch {
			// 剪贴板不可用（权限/非安全上下文）：静默
		}
	};

	const meta = `${t(`error.meta.${error.source}`)} · ${formatTime(error.timestamp)}`;
	const severityClass =
		error.severity === "warning" ? "text-warn" : error.severity === "info" ? "text-info" : "text-err";

	const actions = useMemo(() => {
		const list = [];
		for (const action of error.actions) {
			if (action === "retry") list.push({ action, label: t("error.action.retry") });
			else if (action === "compact") list.push({ action, label: t("error.action.compact") });
			else if (action === "openSettings") list.push({ action, label: t("error.action.openSettings") });
			else if (action === "copyDetail") list.push({ action, label: t("error.action.copyDetail") });
		}
		return list;
	}, [error.actions, t]);

	return (
		<details className="error-note drawer-details">
			<summary>
				<span className={`error-note-sev ${severityClass}`}>
					<ErrorCircleIcon />
				</span>
				<span className="error-note-title truncate">
					{t(error.titleKey as MessageKey, error.titleParams)}
				</span>
				<span className="error-note-meta">{meta}</span>
				<span className="error-note-chev">
					<ChevronRightIcon />
				</span>
			</summary>
			<div className="error-note-body">
				{error.detail && <pre className="error-note-detail">{error.detail}</pre>}
				{error.hintKey && <p className="error-note-hint">{t(error.hintKey as MessageKey)}</p>}
				<div className="error-note-actions">
					{actions.map(({ action, label }) => (
						<button
							key={action}
							type="button"
							className={`error-note-act${action === "retry" ? " strong" : ""}`}
							disabled={action === "retry" && (!retryAvailable || readOnly)}
							onClick={() => {
								if (action === "retry" && sessionId) void retryFailedTurn(sessionId, cardId);
								else if (action === "compact" && sessionId)
									void getExecutionApi(sessionId).compact({ sessionId });
								else if (action === "openSettings") useSettingsStore.getState().openWith();
								else if (action === "copyDetail") void copyDetail();
							}}
						>
							{action === "retry" ? (
								<RefreshIcon />
							) : action === "openSettings" ? (
								<GearIcon />
							) : action === "copyDetail" ? (
								<CopyIcon />
							) : null}
							{label}
						</button>
					))}
					{error.detail && (
						<span className={`error-note-copied${copied ? " on" : ""}`}>{t("error.copied")}</span>
					)}
				</div>
			</div>
		</details>
	);
}

function formatTime(timestamp: number): string {
	try {
		return new Date(timestamp).toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
	} catch {
		return "";
	}
}
