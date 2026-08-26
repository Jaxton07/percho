import { formatSkillCommand, type ImageInput } from "@percho/shared";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { Slot } from "../../plugins/Slot";
import { UI_SLOTS } from "../../plugins/slots";
import { useSessionsStore } from "../../stores/sessions";
import type { UIMessage } from "../../stores/transcript";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";
import { ForkIcon, UndoIcon } from "../icons";
import { AssistantMessage } from "./AssistantMessage";
import { ImagePreviewOverlay, imageSrc } from "./ImagePreview";
import { SubagentRunCard } from "./SubagentRunCard";

/** 复制按钮（用户气泡/助手正文共用）：常驻显示，复制成功短暂变为对勾 */
function CopyButton({ text }: { text: string }) {
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
			{copied ? (
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					className="text-green-500"
					aria-hidden="true"
				>
					<path d="M20 6 9 17l-5-5" />
				</svg>
			) : (
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<rect x="9" y="9" width="13" height="13" rx="2" />
					<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
				</svg>
			)}
		</button>
	);
}

/** 分叉按钮：以该 assistant 消息为结尾生成新会话并切换；agent 运行、压缩或分叉中禁用 */
function ForkButton({ entryId, matchText }: { entryId?: string; matchText: string }) {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const sessionBusy = useTranscriptStore((s) => {
		const transcript = selectTranscript(s, activeSessionId);
		return transcript.agentActive || transcript.compacting;
	});
	const forkSession = useSessionsStore((s) => s.forkSession);
	const [forking, setForking] = useState(false);
	// 只读会话（subagent 检视）不提供分叉
	const readOnly = useSessionsStore(
		(s) => s.sessions.find((session) => session.sessionId === s.activeSessionId)?.readOnly === true,
	);
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
function RecallButton({
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
	const sessionBusy = useTranscriptStore((s) => {
		const transcript = selectTranscript(s, activeSessionId);
		return transcript.agentActive || transcript.compacting;
	});
	const recallMessage = useSessionsStore((s) => s.recallMessage);
	const [recalling, setRecalling] = useState(false);
	// 只读会话（subagent 检视）不提供撤回
	const readOnly = useSessionsStore(
		(s) => s.sessions.find((session) => session.sessionId === s.activeSessionId)?.readOnly === true,
	);
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

/** 单条消息：按类型分发（用户气泡 / 错误 / 助手消息体） */
export const MessageItem = memo(function MessageItem({
	message,
	streaming,
	metaInGroup,
	showActions = true,
}: {
	message: UIMessage;
	streaming?: boolean;
	/** 思考/工具已并入上方合并组，不再自行包裹（正文消息由 MessageList 调用） */
	metaInGroup?: boolean;
	/** 是否渲染操作行：仅轮次最后一段正文为 true（中间自言自语不挂复制/fork，减少噪音） */
	showActions?: boolean;
}) {
	const t = useT();
	const [previewImage, setPreviewImage] = useState<ImageInput | null>(null);

	if (message.kind === "user") {
		return (
			<div className="group flex justify-end">
				<div className="max-w-[85%]">
					{message.images.length > 0 && (
						<div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
							{message.images.map((image, index) => (
								<button
									// biome-ignore lint/suspicious/noArrayIndexKey: 缩略图列表不可变（删除为整列表替换）
									key={index}
									type="button"
									className="h-16 w-16 overflow-hidden rounded-lg border border-border"
									onClick={() => setPreviewImage(image)}
								>
									<img
										src={imageSrc(image)}
										alt={`${t("composer.previewImage")} ${index + 1}`}
										className="h-full w-full object-cover"
									/>
								</button>
							))}
						</div>
					)}
					{message.skill ? (
						<div className="rounded-2xl rounded-br-md bg-border px-3.5 py-2 text-[14px] leading-relaxed text-ink select-text">
							<div
								className={
									message.text
										? "mb-1 font-mono text-[12px] text-ink-dim"
										: "font-mono text-[12px] text-ink-dim"
								}
							>
								{t("message.skillInvocation", { name: message.skill.name })}
							</div>
							{message.text && <div className="whitespace-pre-wrap break-words">{message.text}</div>}
						</div>
					) : (
						message.text && (
							<div className="rounded-2xl rounded-br-md bg-border px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap break-words text-ink select-text">
								{message.text}
							</div>
						)
					)}
					{(message.skill || message.text || message.images.length > 0) && (
						<div className="mt-1 flex items-center justify-end gap-1">
							{(message.skill || message.text) && (
								<CopyButton text={message.skill ? formatSkillCommand(message.skill) : message.text} />
							)}
							<RecallButton
								entryId={message.entryId}
								matchText={message.sourceText ?? message.text}
								timestamp={message.timestamp}
							/>
						</div>
					)}
				</div>
				{previewImage && <ImagePreviewOverlay image={previewImage} onClose={() => setPreviewImage(null)} />}
			</div>
		);
	}

	if (message.kind === "image") {
		// show_image 发图：assistant 侧独立图片块，点击全屏预览。
		// 单图自然比例；多图统一正方形缩略图按数量分档（一行优先，超出 flex-wrap 换行）
		const count = message.images.length;
		const sizeClass =
			count === 1
				? "max-h-36 max-w-48 object-contain"
				: count <= 3
					? "h-24 w-24 object-cover"
					: count <= 6
						? "h-20 w-20 object-cover"
						: "h-16 w-16 object-cover";
		return (
			<div>
				<div className="flex flex-wrap gap-2">
					{message.images.map((image, index) => (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: 图片列表不可变
							key={index}
							type="button"
							className="overflow-hidden rounded-xl border border-border"
							onClick={() => setPreviewImage(image)}
						>
							<img src={imageSrc(image)} alt={t("message.image")} className={sizeClass} />
						</button>
					))}
				</div>
				{previewImage && <ImagePreviewOverlay image={previewImage} onClose={() => setPreviewImage(null)} />}
			</div>
		);
	}

	if (message.kind === "subagent") {
		return <Slot name={UI_SLOTS.SubagentCard} props={{ runs: message.runs }} fallback={SubagentRunCard} />;
	}

	if (message.kind === "error") {
		return (
			<div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-600 select-text">
				{message.text}
			</div>
		);
	}

	if (message.kind === "system") {
		return <SystemMessage message={message} />;
	}

	return (
		<div className="group">
			<AssistantMessage
				text={message.text}
				thinking={message.thinking}
				tools={message.tools}
				streaming={streaming}
				metaInGroup={metaInGroup}
			/>
			{/* 操作行（仅轮次最后一段正文）：复制正文 + 从此处分叉；agent 回复结束后出现 */}
			{!streaming && message.text && showActions && (
				<div className="mt-0.5 flex items-center gap-1">
					<CopyButton text={message.text} />
					<ForkButton entryId={message.entryId} matchText={message.sourceText ?? message.text} />
				</div>
			)}
		</div>
	);
});

/** 上下文压缩分割线：──── 状态文字 ────（codex/opencode 式）；done 态摘要可点击展开 */
function SystemMessage({ message }: { message: Extract<UIMessage, { kind: "system" }> }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const compact = message.compact;
	if (!compact) {
		const mutex = message.mutex;
		if (mutex) {
			const fileName = mutex.extensionPath.split(/[\\/]/).pop() ?? mutex.extensionPath;
			return (
				<CompactionDivider>
					{t("message.subagent.mutex", { path: fileName, tools: mutex.tools.join(", ") })}
				</CompactionDivider>
			);
		}
		return <CompactionDivider>{message.text}</CompactionDivider>;
	}
	const reason = t(`compaction.reason.${compact.reason}`);

	if (compact.status === "running") {
		return (
			<CompactionDivider>
				<span className="h-3 w-3 animate-spin rounded-full border-2 border-border-strong border-t-ink-dim" />
				<span>
					{t("compaction.running")} · {reason}
				</span>
			</CompactionDivider>
		);
	}
	if (compact.status === "cancelled") {
		return (
			<CompactionDivider>
				{t("compaction.cancelled")} · {reason}
			</CompactionDivider>
		);
	}
	if (compact.status === "error") {
		// 提醒级信息（多为无可压缩内容等非致命原因），琥珀色而非错误红
		return (
			<CompactionDivider className="text-amber-500">
				{t("compaction.failed", { error: compact.errorMessage ?? "" })}
			</CompactionDivider>
		);
	}
	const tokens =
		compact.tokensBefore != null && compact.tokensAfter != null
			? ` · ${formatTokens(compact.tokensBefore)} → ${formatTokens(compact.tokensAfter)}`
			: "";
	return (
		<div>
			<CompactionDivider>
				<span>
					{t("compaction.done")} · {reason}
					{tokens}
				</span>
				{compact.summary && (
					<button
						type="button"
						className="transition-colors hover:text-ink-2"
						onClick={() => setExpanded((v) => !v)}
					>
						{t("compaction.summary")} {expanded ? "▴" : "▾"}
					</button>
				)}
			</CompactionDivider>
			{expanded && compact.summary && (
				<p className="mx-auto max-w-[560px] px-3 pb-1 text-center text-xs leading-relaxed break-words text-ink-dim select-text">
					{compact.summary}
				</p>
			)}
		</div>
	);
}

function CompactionDivider({
	children,
	className = "text-ink-faint",
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={`flex items-center gap-3 py-1 text-xs select-none ${className}`}>
			<span className="h-px flex-1 bg-border" />
			<span className="flex items-center gap-2">{children}</span>
			<span className="h-px flex-1 bg-border" />
		</div>
	);
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}
