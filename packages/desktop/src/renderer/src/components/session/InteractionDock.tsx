import type { ExtensionDialogRequest, ExtensionDialogRespond } from "@percho/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useTranscriptStore } from "../../stores/transcript";
import { ClockIcon, FileTextIcon, HelpIcon, PencilIcon } from "../icons";

/** 退出动画时长，与 globals.css 的 dock-exit（approval-exit）同步 */
const EXIT_MS = 150;

const KIND_GLYPH = {
	select: HelpIcon,
	input: PencilIcon,
	editor: FileTextIcon,
	// confirm 与 select 同为提问语义（accent 问号），琥珀三角只保留给权限审批（D2 双身份）
	confirm: HelpIcon,
} as const;

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

/** 标题右侧元信息：倒计时（等宽数字）与排队数，都退到 ink-faint（画板②①） */
function HeadMeta({ request, queueCount }: { request: ExtensionDialogRequest; queueCount: number }) {
	const t = useT();
	const { timeoutMs, requestedAt } = request;
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (timeoutMs === undefined) return;
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [timeoutMs]);
	const remainingSec =
		timeoutMs === undefined ? null : Math.max(0, Math.ceil((timeoutMs - (now - requestedAt)) / 1000));
	return (
		<>
			{remainingSec !== null && (
				<span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-ink-faint tabular-nums">
					<ClockIcon size={11} />
					{remainingSec}s
				</span>
			)}
			{queueCount > 0 && (
				<span className="shrink-0 text-[11px] text-ink-faint">
					{t("interaction.queueMore", { count: queueCount })}
				</span>
			)}
		</>
	);
}

/**
 * 扩展交互停靠槽（issue #45；设计稿 extension-dialogs v1.1 画板①-⑤）：
 * ctx.ui.select/input/editor/confirm → 底部停靠槽四卡（与 ApprovalDock 同位互换）。
 * 容器走 error-system 无边框语言（rounded-[14px] · surface · shadow-soft），身份 = 一枚
 * 14px accent glyph；操作全部幽灵文字按钮（主操作 ink 加重）。取消就是取消——Esc/取消
 * 按钮返回契约取消值，绝不伪造输入（D3）。倒计时由 backend 裁决（D4），这里只是显示器。
 */
export function InteractionDock({ sessionId }: { sessionId: string | null }) {
	const t = useT();
	const pending = useTranscriptStore((s) => (sessionId ? s.bySession[sessionId]?.pendingDialogs : undefined));
	const resolveExtensionDialog = useTranscriptStore((s) => s.resolveExtensionDialog);
	const request = pending?.[0] ?? null;
	const queueCount = (pending?.length ?? 1) - 1;

	// shown：正在显示（含退出动画中）的请求；request 消失后保留 EXIT_MS 播退出（同 ApprovalDock）
	const [shown, setShown] = useState<ExtensionDialogRequest | null>(null);
	const [leaving, setLeaving] = useState(false);
	// 应答 IPC 失败：请求保留在队列（扩展仍在等待），展示错误供重试（D3）
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	// select 键盘高亮（默认第一项；↑↓ 移动 / Enter 确认 / 数字直选）
	const [highlight, setHighlight] = useState(0);
	const cardRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const editorRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (request) {
			setShown(request);
			setLeaving(false);
			setError(null);
			setHighlight(0);
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

	// 聚焦：select/confirm 聚卡容器（吃方向键/数字/Enter），input/editor 聚输入件
	useEffect(() => {
		if (!shown || leaving) return;
		if (shown.kind === "input") inputRef.current?.focus();
		else if (shown.kind === "editor") editorRef.current?.focus();
		else cardRef.current?.focus();
	}, [shown, leaving]);

	// 应答链：await IPC 成功才移除 UI（失败保留请求，扩展不丢等待）；resolved 事件双路径幂等
	const respond = useCallback(
		async (answer: ExtensionDialogRespond) => {
			if (!shown || leaving || !sessionId || sending) return;
			setSending(true);
			setError(null);
			try {
				await getPi().respondExtensionDialog(shown.id, answer);
				resolveExtensionDialog(sessionId, shown.id);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setSending(false);
			}
		},
		[shown, leaving, sessionId, sending, resolveExtensionDialog],
	);

	const options = shown?.kind === "select" ? (shown.options ?? []) : [];

	// 卡片键盘：Esc=取消（stopPropagation 防触发全局中止/关面板）；select 另吃 ↑↓/Enter/数字
	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			void respond({ cancelled: true });
			return;
		}
		if (shown?.kind !== "select" || options.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setHighlight((h) => (h + 1) % options.length);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setHighlight((h) => (h - 1 + options.length) % options.length);
		} else if (e.key === "Enter") {
			e.preventDefault();
			void respond({ value: options[highlight] ?? "" });
		} else if (/^[1-9]$/.test(e.key)) {
			const idx = Number(e.key) - 1;
			if (idx < options.length) {
				e.preventDefault();
				void respond({ value: options[idx] ?? "" });
			}
		}
	};

	if (!shown) return null;

	const hint =
		shown.kind === "select"
			? t("interaction.hintSelect")
			: shown.kind === "input"
				? t("interaction.hintInput")
				: shown.kind === "editor"
					? t("interaction.hintEditor")
					: t("interaction.hintConfirm");
	const Glyph = KIND_GLYPH[shown.kind];

	return (
		// z-20 同 ApprovalDock：审批卡在下方时缩略图 × 会伸出容器顶
		<div className="relative z-20 shrink-0 px-6 pb-3">
			<div className="mx-auto max-w-[760px]">
				<div
					key={shown.id}
					ref={cardRef}
					// eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 聚焦容器吃键盘（select 方向键/数字直选）
					tabIndex={-1}
					role="dialog"
					aria-modal
					onKeyDown={onKeyDown}
					className={`dock-in flex flex-col gap-2.5 rounded-[14px] bg-surface px-3.5 pt-3 pb-2.5 shadow-soft outline-none ${
						leaving ? "dock-exit" : ""
					}`}
				>
					<div className="flex min-h-5 items-center gap-2">
						<span className="flex-none text-accent" aria-hidden="true">
							<Glyph />
						</span>
						<h3 className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-[-0.01em] text-ink-2">
							{shown.title}
						</h3>
						<HeadMeta request={shown} queueCount={queueCount} />
					</div>

					{shown.kind === "select" && (
						<div className="-mx-1.5 flex flex-col gap-px">
							{options.map((option, i) => (
								<button
									// biome-ignore lint/suspicious/noArrayIndexKey: 选项无稳定 id，顺序即语义
									key={`${i}-${option}`}
									type="button"
									onClick={() => void respond({ value: option })}
									onMouseEnter={() => setHighlight(i)}
									className={`flex items-baseline gap-2 rounded-[9px] px-2.5 py-1.5 text-left text-[13px] text-ink-2 transition-colors ${
										i === highlight ? "bg-hover" : ""
									}`}
								>
									<span className="w-3 flex-none text-right text-[10.5px] text-ink-faint tabular-nums">
										{i + 1}
									</span>
									<span className="min-w-0 break-words">{option}</span>
								</button>
							))}
						</div>
					)}

					{shown.kind === "input" && (
						<InputBody
							inputRef={inputRef}
							placeholder={shown.placeholder}
							onSubmit={(value) => void respond({ value })}
						/>
					)}

					{shown.kind === "editor" && (
						<EditorBody
							editorRef={editorRef}
							prefill={shown.prefill}
							onSubmit={(value) => void respond({ value })}
						/>
					)}

					{shown.kind === "confirm" && shown.message && (
						<p className="text-[13px] leading-relaxed break-words whitespace-pre-wrap text-ink-2">
							{shown.message}
						</p>
					)}

					{error && (
						<p className="rounded-lg bg-hover px-2.5 py-1.5 text-[12px] break-all text-err">{error}</p>
					)}

					<div className="flex items-center gap-0.5">
						<span className="text-[11px] text-ink-faint">{hint}</span>
						<div className="ml-auto flex items-center gap-0.5">
							{shown.timeoutMs !== undefined && (
								<span className="mr-1 text-[11px] text-ink-faint">{t("interaction.timedOutNote")}</span>
							)}
							{shown.kind === "confirm" ? (
								<>
									<GhostAction onClick={() => void respond({ cancelled: true })}>
										{t("interaction.no")}
									</GhostAction>
									<GhostAction strong onClick={() => void respond({ confirmed: true })}>
										{t("interaction.yes")}
									</GhostAction>
								</>
							) : (
								<>
									<GhostAction onClick={() => void respond({ cancelled: true })}>
										{t("interaction.cancel")}
									</GhostAction>
									{(shown.kind === "input" || shown.kind === "editor") && (
										<GhostAction
											strong
											onClick={() => {
												const value =
													shown.kind === "input"
														? (inputRef.current?.value ?? "")
														: (editorRef.current?.value ?? shown.prefill ?? "");
												void respond({ value });
											}}
										>
											{t("interaction.submit")}
										</GhostAction>
									)}
								</>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

/** input 单行体：无框，底部一根 hairline，聚焦染 accent（画板③）；空串如实提交 */
function InputBody({
	inputRef,
	placeholder,
	onSubmit,
}: {
	inputRef: React.RefObject<HTMLInputElement | null>;
	placeholder?: string;
	onSubmit: (value: string) => void;
}) {
	return (
		<div className="flex items-center gap-2 border-b border-border px-0.5 pt-1 pb-1.5 focus-within:border-accent">
			<input
				ref={inputRef}
				type="text"
				placeholder={placeholder}
				className="min-w-0 flex-1 border-none bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-faint"
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						// 阻止冒泡到卡片层（卡片层 Enter 只在 select 用）
						e.stopPropagation();
						onSubmit(e.currentTarget.value);
					}
				}}
			/>
		</div>
	);
}

/** editor 多行体：bg-hover 浅底 mono 块（报错详情同款容器语言），⌘Enter 提交（画板④）；
 *  Esc 不在此拦截——冒泡到卡片层统一取消（REVIEW BUG-1：拦截会导致 editor 卡无法 Esc 取消） */
function EditorBody({
	editorRef,
	prefill,
	onSubmit,
}: {
	editorRef: React.RefObject<HTMLTextAreaElement | null>;
	prefill?: string;
	onSubmit: (value: string) => void;
}) {
	return (
		<textarea
			ref={editorRef}
			defaultValue={prefill}
			spellCheck={false}
			rows={4}
			className="max-h-[200px] min-h-24 w-full resize-none rounded-[10px] bg-hover px-2.5 py-2 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-ink-2 outline-none focus:ring-1 focus:ring-border-strong"
			onKeyDown={(e) => {
				if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					e.stopPropagation();
					onSubmit(e.currentTarget.value);
				}
			}}
		/>
	);
}
