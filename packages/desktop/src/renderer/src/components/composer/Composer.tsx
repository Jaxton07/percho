import type { ImageInput } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { COMPOSER_FOCUS_EVENT, EMPTY_DRAFT, NEW_SESSION_DRAFT_KEY, useDraftStore } from "../../stores/drafts";
import { useSessionsStore } from "../../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";
import { ImagePreviewOverlay } from "../chat/ImagePreview";
import { ArrowUpIcon, PlusIcon, StopIcon } from "../icons";
import { AtMenu } from "./AtMenu";
import { AttachmentChip } from "./AttachmentChip";
import { ContextRing } from "./ContextRing";
import { ImageTray } from "./ImageTray";
import { ModelPicker } from "./ModelPicker";
import { QueueBar } from "./QueueBar";
import { SendErrorBar } from "./SendErrorBar";
import { SlashMenu } from "./SlashMenu";
import { ThinkingPicker } from "./ThinkingPicker";
import { useAtCompletion } from "./use-at-completion";
import { useComposerSend } from "./use-composer-send";
import { useSlashMenu } from "./use-slash-menu";

/**
 * 底部输入框：自动增高、Enter 发送、生成中变停止；centered 用于空态居中布局。
 * 逻辑域拆在同目录 hooks（use-composer-send / use-slash-menu / use-at-completion），
 * 本组件只做装配与键盘事件的分发组合。
 */
export function Composer({ centered = false }: { centered?: boolean }) {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	/** 只读会话（subagent 产物检视）：输入/发送/图片全禁，模型与思考档位选择器置灰 */
	const readOnly = useSessionsStore(
		(s) => s.sessions.find((session) => session.sessionId === s.activeSessionId)?.readOnly === true,
	);
	const cwd = useSessionsStore((s) => s.cwd);
	/** 信任决策应答后递增：draft 斜杠菜单按新决策（信任与否）重拉命令 */
	const trustVersion = useSessionsStore((s) => s.trustVersion);
	const transcript = useTranscriptStore((s) => selectTranscript(s, activeSessionId));
	/** 草稿（文本/图片/命令胶囊）按会话持久：切换会话/空态↔列表态换 Composer 实例不丢、不串会话 */
	const draftKey = activeSessionId ?? NEW_SESSION_DRAFT_KEY;
	const draft = useDraftStore((s) => s.bySession[draftKey] ?? EMPTY_DRAFT);
	const { text, images, slashCommand, attachments } = draft;
	const updateDraft = useDraftStore((s) => s.updateDraft);
	const setText = (updater: string | ((prev: string) => string)) => {
		updateDraft(draftKey, (d) => ({ ...d, text: typeof updater === "function" ? updater(d.text) : updater }));
	};
	const setImages = (updater: ImageInput[] | ((prev: ImageInput[]) => ImageInput[])) => {
		updateDraft(draftKey, (d) => ({
			...d,
			images: typeof updater === "function" ? updater(d.images) : updater,
		}));
	};
	const setSlashCommand = (command: string | null) => {
		updateDraft(draftKey, (d) => ({ ...d, slashCommand: command }));
	};
	const setAttachments = (updater: string[] | ((prev: string[]) => string[])) => {
		updateDraft(draftKey, (d) => ({
			...d,
			attachments: typeof updater === "function" ? updater(d.attachments) : updater,
		}));
	};
	const [previewImage, setPreviewImage] = useState<ImageInput | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const followUpQueue = transcript.followUpQueue;
	/** 压缩进行中：禁发（SDK 拒绝压缩中的 prompt；提前拦截保住草稿，warn 提示代替报错丢文本） */
	const compacting = transcript.compacting;
	/** 输入框有内容：streaming 中按钮从停止切回发送（入队后文本清空自动切回停止） */
	const hasContent =
		Boolean(text.trim()) || images.length > 0 || Boolean(slashCommand) || attachments.length > 0;

	const send = useComposerSend({
		activeSessionId,
		text,
		images,
		attachments,
		slashCommand,
		followUpQueue,
		compacting,
		agentActive: transcript.agentActive,
		setText,
		setImages,
		setAttachments,
		setSlashCommand,
	});
	const { sending, error, setError, feedback, showFeedback, ensureSession, runSlashCommand, handleSend } =
		send;
	const focusTextarea = () => textareaRef.current?.focus();
	const isStreaming = transcript.phase === "streaming" || sending;
	const placeholder = readOnly
		? t("composer.placeholderReadOnly")
		: compacting
			? t("composer.placeholderCompacting")
			: isStreaming
				? t("composer.placeholderQueued")
				: t("composer.placeholder");

	const slash = useSlashMenu({
		activeSessionId,
		cwd,
		trustVersion,
		text,
		slashCommand,
		setText,
		setSlashCommand,
		textareaRef,
		ensureSession,
		runSlashCommand,
		handleSend,
		showFeedback,
		setError,
	});

	const at = useAtCompletion({
		cwd,
		text,
		attachments,
		slashOpen: slash.slashOpen,
		setText,
		setAttachments,
		textareaRef,
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: 高度由文本 DOM 变化驱动，显式依赖 text 便于触发
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}, [text]);

	// 撤回回填草稿后聚焦输入框继续编辑（sessions store 派发，window 事件解耦组件间依赖）
	useEffect(() => {
		const onFocusRequest = () => textareaRef.current?.focus();
		window.addEventListener(COMPOSER_FOCUS_EVENT, onFocusRequest);
		return () => window.removeEventListener(COMPOSER_FOCUS_EVENT, onFocusRequest);
	}, []);

	// 点击输入框容器外部时收起命令/文件面板（文本保留；继续输入时恢复）
	const { setSlashDismissed } = slash;
	const { setAtDismissed } = at;
	useEffect(() => {
		if (!slash.slashOpen && !at.atOpen) return;
		const onPointerDown = (e: PointerEvent) => {
			if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
				setSlashDismissed(true);
				setAtDismissed(true);
			}
		};
		window.addEventListener("pointerdown", onPointerDown);
		return () => window.removeEventListener("pointerdown", onPointerDown);
	}, [slash.slashOpen, at.atOpen, setSlashDismissed, setAtDismissed]);

	/** 文本变化：重置菜单折叠态 + 探测光标前 @ / slash token（驱动两个菜单） */
	const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		slash.setSlashDismissed(false);
		at.setAtDismissed(false);
		setText(e.target.value);
		const cursor = e.target.selectionStart ?? e.target.value.length;
		slash.updateToken(e.target.value, cursor);
		at.updateToken(e.target.value, cursor);
	};

	/** 光标移动（点击/方向键）：重探 slash token（@ 菜单仅输入驱动，点进去不弹） */
	const handleSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
		const el = e.currentTarget;
		slash.updateToken(el.value, el.selectionStart ?? el.value.length);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (at.handleKeyDown(e)) return;
		if (slash.handleKeyDown(e)) return;
		// 胶囊撤销：Esc（任意文本态，菜单未消费时）；空文本 Backspace/Delete 先 @ 胶囊后 slash 胶囊
		if (slashCommand && e.key === "Escape") {
			slash.restoreSlashPill(e);
			return;
		}
		if (text === "" && (e.key === "Backspace" || e.key === "Delete")) {
			if (attachments.length > 0) {
				e.preventDefault();
				at.handleAttachmentRemove(attachments.length - 1);
				return;
			}
			if (slashCommand) {
				slash.restoreSlashPill(e);
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void handleSend();
		}
	};

	const handleFiles = (files: FileList | File[] | null) => {
		if (!files || files.length === 0) return;
		for (const file of Array.from(files)) {
			if (!file.type.startsWith("image/")) continue;
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result;
				if (typeof result !== "string") return;
				const comma = result.indexOf(",");
				if (comma === -1) return;
				setImages((prev) => [...prev, { data: result.slice(comma + 1), mimeType: file.type }]);
			};
			reader.readAsDataURL(file);
		}
	};

	/** 截图/复制图片后 Ctrl+V 粘贴到输入框 */
	const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (const item of items) {
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) files.push(file);
			}
		}
		if (files.length === 0) return;
		e.preventDefault();
		handleFiles(files);
	};

	return (
		<div ref={boxRef} className={centered ? "w-full max-w-[760px]" : "shrink-0 px-6 pb-3"}>
			<div className="mx-auto max-w-[760px]">
				{error && <SendErrorBar error={error} onRetry={() => void handleSend()} />}
				{feedback && !error && (
					<p className={`mb-1.5 text-xs ${feedback.tone === "warn" ? "text-amber-500" : "text-ink-dim"}`}>
						{feedback.message}
					</p>
				)}
				{slash.slashOpen && (
					<SlashMenu
						commands={slash.slashCommands}
						query={slash.slashQuery}
						selectedIndex={slash.slashSelected}
						onSelectedIndexChange={slash.setSlashSelected}
						onPick={(command) => void slash.handleSlashPick(command)}
					/>
				)}
				{at.atOpen && (
					<AtMenu
						files={at.atFiltered}
						selectedIndex={at.atSelected}
						onSelectedIndexChange={at.setAtSelected}
						onPick={at.handleAtPick}
					/>
				)}
				{followUpQueue.length > 0 && (
					<QueueBar
						text={followUpQueue[0] ?? ""}
						onRestore={() => void send.handleRestoreQueue(focusTextarea)}
					/>
				)}
				<ImageTray
					images={images}
					onPreview={setPreviewImage}
					onRemove={(index) => setImages((prev) => prev.filter((_, i) => i !== index))}
				/>
				<div className="rounded-2xl border-[0.5px] border-border bg-surface shadow-soft">
					{slashCommand || attachments.length > 0 ? (
						<div className="flex flex-wrap items-start gap-1.5 px-4 pt-5 pb-2">
							{slashCommand && (
								<span className="mt-0.5 shrink-0 select-none rounded-md bg-border px-2 py-0.5 font-mono text-[12px] leading-5 text-ink-2">
									/{slashCommand}
								</span>
							)}
							{attachments.map((path, index) => (
								<AttachmentChip key={path} path={path} onRemove={() => at.handleAttachmentRemove(index)} />
							))}
							<textarea
								ref={textareaRef}
								className="max-h-[200px] min-w-[140px] flex-1 resize-none bg-transparent pt-0.5 text-[14px] leading-relaxed outline-none placeholder:text-ink-faint select-text"
								placeholder={slashCommand ? t("slash.argPlaceholder") : placeholder}
								value={text}
								rows={1}
								disabled={readOnly}
								onChange={handleTextChange}
								onKeyDown={handleKeyDown}
								onSelect={handleSelect}
								onPaste={handlePaste}
							/>
						</div>
					) : (
						<textarea
							ref={textareaRef}
							className="max-h-[200px] w-full resize-none rounded-t-2xl px-4 pt-5 pb-2 text-[14px] leading-relaxed bg-transparent outline-none placeholder:text-ink-faint select-text"
							placeholder={placeholder}
							value={text}
							rows={1}
							disabled={readOnly}
							onChange={handleTextChange}
							onKeyDown={handleKeyDown}
							onSelect={handleSelect}
							onPaste={handlePaste}
						/>
					)}
					<div className="flex items-center gap-2 px-3 pb-2">
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							multiple
							className="hidden"
							onChange={(e) => {
								handleFiles(e.target.files);
								e.target.value = "";
							}}
						/>
						<button
							type="button"
							className="-ml-1 -mb-1 flex h-7 w-7 items-center justify-center rounded-lg text-ink-dim transition-colors hover:bg-hover hover:text-ink"
							aria-label={t("composer.addImage")}
							disabled={readOnly}
							onClick={() => fileInputRef.current?.click()}
						>
							<PlusIcon size={18} />
						</button>
						<ContextRing />
						<div className="flex-1" />
						<div className={readOnly ? "pointer-events-none opacity-40" : undefined}>
							<ModelPicker />
						</div>
						<div className={readOnly ? "pointer-events-none opacity-40" : undefined}>
							<ThinkingPicker />
						</div>
						{isStreaming && !hasContent ? (
							<button
								type="button"
								className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-on-ink transition-colors hover:bg-red-600"
								onClick={() => void send.handleStop()}
								aria-label={t("composer.stop")}
							>
								<StopIcon />
							</button>
						) : (
							<button
								type="button"
								className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-on-ink transition-colors hover:bg-ink-2 disabled:opacity-30"
								disabled={readOnly || !hasContent || sending}
								onClick={() => void handleSend()}
								aria-label={t("composer.send")}
							>
								<ArrowUpIcon size={20} />
							</button>
						)}
					</div>
				</div>
			</div>
			{previewImage && <ImagePreviewOverlay image={previewImage} onClose={() => setPreviewImage(null)} />}
		</div>
	);
}
