import { useEffect, useRef, useState } from "react";
import { useSessionBusy, useSessionReadOnly } from "../../hooks/use-session-state";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { CopyActionIcon, CopyCheckIcon, ForkIcon, UndoIcon } from "../icons";

/** 复制按钮（用户气泡/助手正文共用）：常驻显示，复制成功短暂变为对勾 */
export function CopyButton({ text }: { text: string }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const timerRef = useRef(0);

	useEffect(() => () => window.clearTimeout(timerRef.current), []);

	const handleCopy = () => {
		navigator.clipboard
			.writeText(text)
			.then(() => {
				setCopied(true);
				window.clearTimeout(timerRef.current);
				timerRef.current = window.setTimeout(() => setCopied(false), 1200);
			})
			.catch(() => {});
	};

	return (
		<button
			type="button"
			onClick={handleCopy}
			aria-label={copied ? t("message.copied") : t("message.copy")}
			className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-border/70 hover:text-ink-2 disabled:cursor-not-allowed"
		>
			{copied ? <CopyCheckIcon className="text-green-500" /> : <CopyActionIcon />}
		</button>
	);
}

/** 分叉按钮：以该 assistant 消息为结尾生成新会话并切换；agent 运行、压缩或分叉中禁用 */
export function ForkButton({ entryId, matchText }: { entryId?: string; matchText: string }) {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const sessionBusy = useSessionBusy(activeSessionId);
	const forkSession = useSessionsStore((s) => s.forkSession);
	const [forking, setForking] = useState(false);
	// 只读会话（subagent 检视）不提供分叉
	const readOnly = useSessionReadOnly();
	if (readOnly) return null;

	const handleFork = () => {
		if (forking || sessionBusy) return;
		setForking(true);
		// entryId 精确定位（历史消息）；流式刚提交的消息无 entryId，按正文文本兜底匹配
		void forkSession(entryId ? { entryId } : { text: matchText }).finally(() => setForking(false));
	};

	return (
		<button
			type="button"
			onClick={handleFork}
			disabled={sessionBusy || forking}
			aria-label={t("message.fork")}
			className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-border/70 hover:text-ink-2 disabled:cursor-not-allowed"
		>
			<ForkIcon />
		</button>
	);
}

/** 撤回按钮：会话回退到该用户消息之前，内容放回输入框继续编辑；agent 运行或压缩中禁用 */
export function RecallButton({
	entryId,
	matchText,
	timestamp,
}: {
	entryId?: string;
	matchText: string;
	timestamp: number;
}) {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const sessionBusy = useSessionBusy(activeSessionId);
	const recallMessage = useSessionsStore((s) => s.recallMessage);
	const [recalling, setRecalling] = useState(false);
	// 只读会话（subagent 检视）不提供撤回
	const readOnly = useSessionReadOnly();
	if (readOnly) return null;

	const handleRecall = () => {
		if (recalling || sessionBusy) return;
		setRecalling(true);
		// entryId 精确定位（历史消息）；实时消息无 entryId，按持久化文本+时间戳兑底匹配
		void recallMessage({ entryId, text: matchText || undefined, timestamp }).finally(() =>
			setRecalling(false),
		);
	};

	return (
		<button
			type="button"
			onClick={handleRecall}
			disabled={sessionBusy || recalling}
			aria-label={t("message.recall")}
			className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-border/70 hover:text-ink-2 disabled:cursor-not-allowed"
		>
			<UndoIcon />
		</button>
	);
}
