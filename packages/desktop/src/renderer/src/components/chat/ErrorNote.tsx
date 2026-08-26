import type { UIMessage, UiError } from "@percho/shared";
import { useMemo, useState } from "react";
import { getPi } from "../../api";
import { type MessageKey, useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useTranscriptStore } from "../../stores/transcript";
import { ChevronRightIcon, CopyIcon, ErrorCircleIcon, GearIcon, RefreshIcon } from "../icons";

/**
 * 会话内错误条（error-system 画板 ①②③）：无边框悬浮卡片 + severity 一枚 glyph + 幽灵动作。
 * v2 语言：rounded-xl bg-surface shadow-soft（QueueBar/TodoPanel 同款），默认折叠。
 *
 * 动作行：
 * - retry：重发本卡之前最后一条 user 消息（原文 sourceText），错误卡保留（错误确实发生过）；
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

	// 本卡之前最后一条 user 消息（重试用）——按 cardId 定位卡索引，向前找
	const lastUser = useTranscriptStore((s) => {
		if (!sessionId) return undefined;
		const entry = s.bySession[sessionId];
		const messages = entry?.messages ?? [];
		const idx = messages.findLastIndex((m) => m.kind === "error" && m.id === cardId);
		if (idx < 0) return undefined;
		for (let i = idx - 1; i >= 0; i--) {
			const m = messages[i];
			if (m?.kind === "user") return m;
		}
		return undefined;
	});

	const retry = async () => {
		if (!sessionId || !lastUser) return;
		const user = lastUser as Extract<UIMessage, { kind: "user" }>;
		const text = user.sourceText ?? user.text;
		const images = user.images;
		useTranscriptStore.getState().markAgentActive(sessionId, true);
		try {
			await getPi().prompt(sessionId, text, images.length > 0 ? images : undefined);
			// 重发受理：切回该会话（若在看别的会话）
			useSessionsStore.getState().switchSession(sessionId);
		} catch {
			useTranscriptStore.getState().markAgentActive(sessionId, false);
		}
	};

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
							onClick={() => {
								if (action === "retry") void retry();
								else if (action === "compact" && sessionId) void getPi().compact(sessionId);
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
