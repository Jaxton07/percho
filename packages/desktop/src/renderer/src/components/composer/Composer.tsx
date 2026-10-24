import type { ComposerDocument, ImageInput } from "@percho/shared";
import { normalizeComposerDocument } from "@percho/shared";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { useActiveModelInfo, useSessionReadOnly } from "../../hooks/use-session-state";
import { useT } from "../../i18n";
import { selectActiveCwd } from "../../lib/active-cwd";
import { prepareImageAttachment } from "../../lib/image-attachment";
import { RegionHost } from "../../plugins/RegionHost";
import { UI_REGIONS } from "../../plugins/slots";
import {
	COMPOSER_FOCUS_EVENT,
	draftText,
	EMPTY_DRAFT,
	NEW_SESSION_DRAFT_KEY,
	restoreFailedDraft,
	useDraftStore,
	withDraftText,
} from "../../stores/drafts";
import { useSessionsStore } from "../../stores/sessions";
import { pushToast } from "../../stores/toasts";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";
import { ImagePreviewOverlay } from "../chat/ImagePreview";
import { ArrowUpIcon, PencilIcon, PlusIcon, StopIcon } from "../icons";
import { AtMenu } from "./AtMenu";
import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor";
import { ContextRing } from "./ContextRing";
import "./composer-editor.css";
import { resolveDroppedFilePaths } from "./drop-files";
import { ImageTray } from "./ImageTray";
import { ModelPicker } from "./ModelPicker";
import { PermissionPicker } from "./PermissionPicker";
import { QueueBar } from "./QueueBar";
import { QuoteChip } from "./QuoteChip";
import { SendErrorBar } from "./SendErrorBar";
import { SlashMenu } from "./SlashMenu";
import { slashPresentation } from "./slash-label";
import { useAtCompletion } from "./use-at-completion";
import { useComposerSend } from "./use-composer-send";
import { useSlashMenu } from "./use-slash-menu";

/**
 * 命中这些元素的 mousedown 不接管为「聚焦正文」：它们各有自己的交互或原生行为。
 * `[data-composer-overlay]` = 模型/权限弹层根（弹层就渲染在输入框盒子里，不是 portal）。
 */
const COMPOSER_FOCUS_BLOCKERS =
	"button, a, input, textarea, select, label, [role='menu'], [role='listbox'], [role='dialog'], [contenteditable='true'], [data-composer-overlay]";

/**
 * 底部输入框：自动增高、Enter 发送、生成中变停止；centered 用于空态居中布局。
 * 逻辑域拆在同目录 hooks（use-composer-send / use-slash-menu / use-at-completion），
 * 本组件只做装配与键盘事件的分发组合。
 */
export function Composer({ centered = false }: { centered?: boolean }) {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	/** 只读会话（subagent 产物检视）：输入/发送/图片全禁，模型与思考档位选择器置灰 */
	const readOnly = useSessionReadOnly();
	const cwd = useSessionsStore(selectActiveCwd);
	/** 信任决策应答后递增：新会话页的斜杠菜单按新决策（信任与否）重拉命令 */
	const trustVersion = useSessionsStore((s) => s.trustVersion);
	const transcript = useTranscriptStore((s) => selectTranscript(s, activeSessionId));
	/** 扩展 setEditorText 预填来源（一次性提示；用户首次键入清除） */
	const extensionPrefillSource = transcript.extensionPrefillSource;
	/** 图片门控数据源：当前生效模型（会话覆写 ?? 全局默认 → models 表解析，useActiveModelInfo 收拢点） */
	const activeModelInfo = useActiveModelInfo();
	/** 当前模型是否支持图片输入；fail-open：模型未知/字段缺省一律按支持，只拦 imageInput === false */
	const imagesSupported = activeModelInfo?.imageInput !== false;
	/** 输入内容（文本/图片/命令胶囊）按会话持久：真实会话用 sessionId、新会话页用固定 key，不丢也不串 */
	const draftKey = activeSessionId ?? NEW_SESSION_DRAFT_KEY;
	const draft = useDraftStore((s) => s.bySession[draftKey] ?? EMPTY_DRAFT);
	const failedDraft = useDraftStore((s) => s.failedBySession[draftKey]);
	const { document, images, slashCommand, quotes } = draft;
	const text = draftText(draft);
	const updateDraft = useDraftStore((s) => s.updateDraft);
	const setText = (updater: string | ((prev: string) => string)) => {
		updateDraft(draftKey, (d) =>
			withDraftText(d, typeof updater === "function" ? updater(draftText(d)) : updater),
		);
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
	const appendAttachments = useCallback(
		(paths: string[]) => {
			if (!paths.length) return;
			updateDraft(draftKey, (d) => ({
				...d,
				document: normalizeComposerDocument({
					version: 1,
					parts: [
						...d.document.parts,
						...paths.flatMap((path) => [
							{ type: "text" as const, text: " " },
							{ type: "file" as const, path, label: path.split(/[\\/]/).at(-1) },
						]),
					],
				}),
			}));
		},
		[draftKey, updateDraft],
	);
	const setQuotes = (updater: string[] | ((prev: string[]) => string[])) => {
		updateDraft(draftKey, (d) => ({
			...d,
			quotes: typeof updater === "function" ? updater(d.quotes) : updater,
		}));
	};
	const [previewImage, setPreviewImage] = useState<ImageInput | null>(null);
	const editorRef = useRef<ComposerEditorHandle>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const followUpQueue = transcript.followUpQueue;
	/** 压缩进行中：禁发（SDK 拒绝压缩中的 prompt；提前拦截保住草稿，warn 提示代替报错丢文本） */
	const compacting = transcript.compacting;
	/** 输入框有内容：streaming 中按钮从停止切回发送（入队后文本清空自动切回停止） */
	const hasContent = Boolean(text.trim()) || images.length > 0 || Boolean(slashCommand) || quotes.length > 0;

	const send = useComposerSend({
		draftKey,
		activeSessionId,
		imagesSupported,
	});
	const { sending, error, setError, feedback, showFeedback, ensureSession, runSlashCommand, handleSend } =
		send;
	// 附件预处理（缩图）在途的 promise：发送前要等它们落地，否则「粘图立刻回车」会把图丢了
	// （预处理要几百 ms，以前 FileReader 只需几 ms，这个窗口可忽略；现在不能）
	const preparingRef = useRef<{ key: string; generation: number | undefined; promise: Promise<unknown> }[]>(
		[],
	);
	const sendWhenReady = async () => {
		if (readOnly) return;
		const generation =
			draftKey === NEW_SESSION_DRAFT_KEY
				? useSessionsStore.getState().newSessionDraft?.generation
				: undefined;
		const inFlight = preparingRef.current.filter((p) => p.key === draftKey && p.generation === generation);
		await Promise.all(inFlight.map((p) => p.promise));
		if (
			draftKey === NEW_SESSION_DRAFT_KEY &&
			generation !== useSessionsStore.getState().newSessionDraft?.generation
		)
			return;
		await handleSend();
	};
	const focusEditor = () => editorRef.current?.focus();

	/**
	 * 点盒子空白处也进入输入状态：正文只有一行高，正文与底部图标行之间的留白、图标行右侧
	 * 的大片空隙原先点了没反应，还会把刚拿到的光标弄丢。
	 *
	 * 用 mousedown 而不是 click：焦点与原生聚焦同刻完成，不会先失焦再聚焦闪一下。
	 * preventDefault 是关键 —— 否则 mousedown 的默认行为会把选区/焦点清掉。
	 * 命中交互元素（按钮/输入/菜单/弹层…）一律不插手：那是它们自己的事，
	 * 抢过来会让弹层刚开就被关、滑块拖不动。
	 */
	const handleComposerMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
		const target = event.target;
		if (target instanceof Element && target.closest(COMPOSER_FOCUS_BLOCKERS)) return;
		event.preventDefault();
		editorRef.current?.focus();
	};
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
		editorRef,
		ensureSession,
		runSlashCommand,
		// 斜杠菜单的 skill/模板命令也要等附件预处理（它们同样可能带图）
		handleSend: sendWhenReady,
		showFeedback,
		setError,
	});

	const selectedSlashCommand = slash.slashCommands.find((command) => command.name === slashCommand);
	const slashLabel = selectedSlashCommand ? slashPresentation(selectedSlashCommand, t).label : slashCommand;

	const at = useAtCompletion({
		cwd,
		text,
		draftKey,
		slashOpen: slash.slashOpen,
		editorRef,
	});

	// 外部操作请求继续编辑；引用内容时移到末尾，其他聚焦请求保留原光标位置。
	useEffect(() => {
		const onFocusRequest = (event: Event) => {
			editorRef.current?.focus(
				event instanceof CustomEvent && event.detail?.moveToEnd === true ? "end" : undefined,
			);
		};
		window.addEventListener(COMPOSER_FOCUS_EVENT, onFocusRequest);
		return () => window.removeEventListener(COMPOSER_FOCUS_EVENT, onFocusRequest);
	}, []);

	// Electron sandbox 中 File.path 已移除；preload 通过 webUtils 恢复原生路径并送入现有附件管线。
	useEffect(() => {
		if (readOnly) return;
		const containsFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
		const onDragOver = (event: DragEvent) => {
			if (!containsFiles(event)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		};
		const onDrop = (event: DragEvent) => {
			if (!containsFiles(event) || !event.dataTransfer) return;
			event.preventDefault();
			appendAttachments(resolveDroppedFilePaths(event.dataTransfer.files, getPi().getPathForFile));
		};
		window.addEventListener("dragover", onDragOver);
		window.addEventListener("drop", onDrop);
		return () => {
			window.removeEventListener("dragover", onDragOver);
			window.removeEventListener("drop", onDrop);
		};
	}, [appendAttachments, readOnly]);

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

	/** 文本变化：重置菜单折叠态 + 探测光标前 @ / slash token（驱动两个菜单）；同时清预填来源提示 */
	const handleTextChange = (next: ComposerDocument, value: string, cursor: number) => {
		if (extensionPrefillSource) useTranscriptStore.getState().clearExtensionPrefill(activeSessionId ?? "");
		slash.setSlashDismissed(false);
		at.setAtDismissed(false);
		updateDraft(draftKey, (d) => ({ ...d, document: next }));
		slash.updateToken(value, cursor);
		at.updateToken(value, cursor);
	};

	/** 光标移动（点击/方向键）：重探 slash token（@ 菜单仅输入驱动，点进去不弹） */
	const handleSelect = (value: string, cursor: number) => {
		slash.updateToken(value, cursor);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (at.handleKeyDown(e)) return;
		if (slash.handleKeyDown(e)) return;
		// 胶囊撤销：Esc（任意文本态，菜单未消费时）；空文本 Backspace/Delete 先 @ 胶囊后 slash 胶囊
		if (slashCommand && e.key === "Escape") {
			slash.restoreSlashPill(e);
			return;
		}
		if (text === "" && (e.key === "Backspace" || e.key === "Delete")) {
			// 胶囊撤销：视觉由近及远（@ 文件 → slash 命令 → 引用）

			if (slashCommand) {
				slash.restoreSlashPill(e);
				return;
			}
			if (quotes.length > 0) {
				e.preventDefault();
				setQuotes((prev) => prev.slice(0, -1));
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void sendWhenReady();
		}
	};

	const handleFiles = (files: FileList | File[] | null) => {
		if (!files || files.length === 0) return;
		// 图片门控入口防御：+ 按钮/粘贴之外的路径不再存在，仍早退兜底
		if (!imagesSupported) return;
		for (const file of Array.from(files)) {
			if (!file.type.startsWith("image/")) continue;
			// 在粘贴/选择时就先把图缩到模型规格（见 lib/image-attachment.ts）：
			// 发送路径上的 SDK 归一化于是只需解码量尺寸（~20-40ms）而不是真缩一遍（~0.8–1.1s）。
			// 失败一律退回原图，不丢附件；在途 promise 交给 preparingRef，回车会等它。
			const generation =
				draftKey === NEW_SESSION_DRAFT_KEY
					? useSessionsStore.getState().newSessionDraft?.generation
					: undefined;
			const original = useDraftStore.getState().bySession[draftKey] ?? EMPTY_DRAFT;
			const prepared = prepareImageAttachment(file).then((image) => {
				if (
					draftKey === NEW_SESSION_DRAFT_KEY &&
					generation !== useSessionsStore.getState().newSessionDraft?.generation
				) {
					// 新会话页已换代：保留为显式可恢复草稿，不能注入后来新建的输入。
					useDraftStore.setState((state) => ({
						failedBySession: {
							...state.failedBySession,
							[draftKey]: {
								...(state.failedBySession[draftKey] ?? original),
								images: [...(state.failedBySession[draftKey]?.images ?? original.images), image],
							},
						},
					}));
					return;
				}
				updateDraft(draftKey, (d) => ({ ...d, images: [...d.images, image] }));
			});
			preparingRef.current.push({ key: draftKey, generation, promise: prepared });
			void prepared.finally(() => {
				preparingRef.current = preparingRef.current.filter((p) => p.promise !== prepared);
			});
		}
	};

	/**
	 * 截图/复制图片后 Ctrl+V 粘贴到输入框。
	 * 从 Finder 粘贴文件另走一条：沙箱里 File 只有 name 没有 path，原生路径必须由 preload 的
	 * webUtils 还原（与拖放同一条 resolveDroppedFilePaths 管线），否则输入框里只会留下一个孤立文件名。
	 */
	const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
		const clipboard = e.clipboardData;
		if (!clipboard) return;
		const documents = Array.from(clipboard.files).filter((file) => !file.type.startsWith("image/"));
		const paths = resolveDroppedFilePaths(documents, getPi().getPathForFile);
		if (paths.length > 0) {
			e.preventDefault();
			appendAttachments(paths);
			return;
		}
		const items = clipboard.items;
		if (!items) return;
		const files: File[] = [];
		for (const item of items) {
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) files.push(file);
			}
		}
		if (files.length === 0) return;
		// 图片门控：纯文本模型拦截粘贴（默认行为可能把图片数据塞进文本框，必须 preventDefault）
		if (!imagesSupported) {
			e.preventDefault();
			// 顶栏右侧 toast 卡（不用内联反馈：该提示不阻塞继续输入，卡片可手动关）
			pushToast("warning", "composer.imageUnsupported");
			return;
		}
		e.preventDefault();
		handleFiles(files);
	};

	return (
		<div ref={boxRef} className={centered ? "w-full max-w-[760px]" : "shrink-0 px-6 pb-3"}>
			{/* relative：ImageTray 悬浮层（absolute bottom-full）的定位锚，浮在错误条/菜单/输入框整列之上 */}
			<div className="relative mx-auto max-w-[760px]">
				{failedDraft && (
					<button
						type="button"
						className="mb-2 text-ui-12 text-ink-dim"
						onClick={() => restoreFailedDraft(draftKey)}
					>
						{t("composer.restoreFailedDraft")}
					</button>
				)}
				{error && <SendErrorBar error={error} onRetry={() => void sendWhenReady()} />}
				{feedback && !error && (
					<p
						className={`mb-1.5 text-ui-12 leading-[calc(1_/_0.75)] ${feedback.tone === "warn" ? "text-amber-500" : "text-ink-dim"}`}
					>
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
						onRestore={() => void send.handleRestoreQueue(focusEditor)}
					/>
				)}
				{/* 扩展 setEditorText 预填提示（画板⑩）：一次性来源标注，首次键入即清除 */}
				{extensionPrefillSource && (
					<div className="flex items-center gap-1.5 px-1 text-ui-11 text-ink-faint">
						<PencilIcon size={11} />
						{t("interaction.prefillNote", { source: extensionPrefillSource })}
					</div>
				)}
				<ImageTray
					images={images}
					onPreview={setPreviewImage}
					onRemove={(index) => setImages((prev) => prev.filter((_, i) => i !== index))}
				/>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: 点留白 = 聚焦正文（与直接点正文等价，纯便利）；
				    不给盒子加 role/ tabIndex，那会让读屏多出一个空的可聚焦区域 */}
				<div
					onMouseDown={handleComposerMouseDown}
					className="rounded-[20px] border-[0.5px] border-border bg-surface shadow-soft"
				>
					{/* 引用胶囊区：独占顶部一行贴边（专为选中引用留的位置，不占正文宽度） */}
					{quotes.length > 0 && (
						<div className="flex flex-wrap items-center gap-1.5 px-3 pt-2">
							{quotes.map((quote) => (
								<QuoteChip
									key={quote}
									quote={quote}
									onRemove={() => setQuotes((prev) => prev.filter((q) => q !== quote))}
								/>
							))}
						</div>
					)}
					{/* 正文行：普通 slash 命令保留参数模式，skill 和文件由编辑器在正文原位置呈现；
					    宿主身份由草稿决定，内容更新不重建编辑器；
					    无引用时文本贴顶（可编辑区向上扩展），引用行临时加一行、不浪费空间 */}
					<div className={`px-4 pb-5.5 ${quotes.length > 0 ? "pt-1.5" : "pt-2"}`}>
						<div
							className={slashCommand ? "relative flex flex-wrap items-start gap-x-1.5 gap-y-1" : "relative"}
						>
							{slashCommand && (
								<span className="mt-0.5 flex shrink-0 select-none items-center rounded-md bg-surface px-2 py-0.5 font-mono text-ui-12 leading-5 text-ink-2 shadow-pop">
									{slashLabel !== slashCommand && <span className="mr-1.5">{slashLabel}</span>}/{slashCommand}
								</span>
							)}

							<ComposerEditor
								key={draftKey}
								ref={editorRef}
								draftKey={draftKey}
								document={document}
								className={slashCommand ? "min-w-[140px] flex-1" : "w-full"}
								placeholder={slashCommand ? t("slash.argPlaceholder") : placeholder}
								readOnly={readOnly}
								onChange={handleTextChange}
								onKeyDown={handleKeyDown}
								onSelectionChange={handleSelect}
								onPaste={handlePaste}
							/>
						</div>
					</div>
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
							className="-ml-1 flex h-7 w-7 items-center justify-center rounded-lg text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
							aria-label={t("composer.addImage")}
							title={!imagesSupported ? t("composer.imageUnsupported") : undefined}
							disabled={readOnly || !imagesSupported}
							onClick={() => fileInputRef.current?.click()}
						>
							<PlusIcon size={18} />
						</button>
						<div className={readOnly ? "pointer-events-none opacity-40" : undefined}>
							<PermissionPicker />
						</div>
						<div className="flex-1" />
						<ContextRing />
						<RegionHost region={UI_REGIONS.ComposerFooter} />
						<div className={readOnly ? "pointer-events-none opacity-40" : undefined}>
							<ModelPicker />
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
								onClick={() => void sendWhenReady()}
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
