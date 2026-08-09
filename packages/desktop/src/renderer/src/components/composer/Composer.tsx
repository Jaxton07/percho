import type { ImageInput, SlashCommandInfo } from "@pi-desktop/shared";
import { useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { EMPTY_DRAFT, NEW_SESSION_DRAFT_KEY, useDraftStore } from "../../stores/drafts";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";
import { ArrowUpIcon, CloseIcon, PlusIcon, StopIcon, UndoIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";
import { AtMenu } from "./AtMenu";
import { type AtToken, extractAtToken, filterFiles } from "./at-files";
import { ContextRing } from "./ContextRing";
import { ModelPicker } from "./ModelPicker";
import { filterCommands, SlashMenu } from "./SlashMenu";
import { ThinkingPicker } from "./ThinkingPicker";

/** 底部输入框：自动增高、Enter 发送、生成中变停止；centered 用于空态居中布局 */
export function Composer({ centered = false }: { centered?: boolean }) {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const cwd = useSessionsStore((s) => s.cwd);
	const createSession = useSessionsStore((s) => s.createSession);
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
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<string | null>(null);
	const [slashSelected, setSlashSelected] = useState(0);
	const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
	/** 点击面板外部后隐藏菜单（保留文本，再次输入时恢复） */
	const [slashDismissed, setSlashDismissed] = useState(false);
	/** @ 文件补全：token 状态 + 项目文件缓存（cwd 变化后重拉） */
	const [atToken, setAtToken] = useState<AtToken | null>(null);
	const [atFiles, setAtFiles] = useState<string[]>([]);
	const [atFilesCwd, setAtFilesCwd] = useState<string | null>(null);
	const [atSelected, setAtSelected] = useState(0);
	const [atDismissed, setAtDismissed] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const isStreaming = transcript.phase === "streaming" || sending;
	const followUpQueue = transcript.followUpQueue;
	/** 输入框有内容：streaming 中按钮从停止切回发送（入队后文本清空自动切回停止） */
	const hasContent =
		Boolean(text.trim()) || images.length > 0 || Boolean(slashCommand) || attachments.length > 0;
	/** 输入以 / 开头时打开命令面板；query = 第一个词（/ 后） */
	const slashOpen = text.startsWith("/") && !slashDismissed;
	const slashQuery = slashOpen ? (text.slice(1).split(" ")[0] ?? "") : "";
	/** trim 后是否已带参数（Enter 时决定执行还是选中） */
	const slashHasArgs = slashOpen && text.trim().includes(" ");
	/** @ 菜单：token 仍与当前文本一致才有效（程序化清空文本后自动失效），slash 打开时不竞争 */
	const atOpen =
		atToken !== null &&
		text.slice(atToken.start, atToken.end) === `@${atToken.query}` &&
		!atDismissed &&
		!slashOpen;
	const atFiltered = atOpen && atToken ? filterFiles(atFiles, atToken.query) : [];

	const showFeedback = (message: string) => {
		setFeedback(message);
		if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
		feedbackTimer.current = setTimeout(() => setFeedback(null), 2500);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: 高度由文本 DOM 变化驱动，显式依赖 text 便于触发
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}, [text]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 查询词变化时重置选中项
	useEffect(() => {
		setSlashSelected(0);
	}, [slashQuery]);

	/** 文本变化：重置菜单折叠态 + 探测光标前 @ token（驱动 @ 菜单） */
	const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setSlashDismissed(false);
		setAtDismissed(false);
		setText(e.target.value);
		setAtToken(extractAtToken(e.target.value, e.target.selectionStart ?? e.target.value.length));
	};

	// @ token 出现时拉取项目文件列表（每 cwd 一次，backend TTL 缓存；atToken 击键频变但条件拦截）
	useEffect(() => {
		if (!atToken || !cwd || atFilesCwd === cwd) return;
		let cancelled = false;
		void getPi()
			.listProjectFiles(cwd)
			.then((list) => {
				if (cancelled) return;
				setAtFiles(list);
				setAtFilesCwd(cwd);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [atToken, cwd, atFilesCwd]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: @ 查询词变化时重置选中项
	useEffect(() => {
		setAtSelected(0);
	}, [atToken?.query]);

	// 点击输入框容器外部时收起命令/文件面板（文本保留；继续输入时恢复）
	useEffect(() => {
		if (!slashOpen && !atOpen) return;
		const onPointerDown = (e: PointerEvent) => {
			if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
				setSlashDismissed(true);
				setAtDismissed(true);
			}
		};
		window.addEventListener("pointerdown", onPointerDown);
		return () => window.removeEventListener("pointerdown", onPointerDown);
	}, [slashOpen, atOpen]);

	// 会话切换时重新拉取命令列表（模板/skill 随项目变化）
	useEffect(() => {
		if (!activeSessionId) return;
		let cancelled = false;
		void getPi()
			.listSlashCommands(activeSessionId)
			.then((list) => {
				if (!cancelled) setSlashCommands(list);
			})
			.catch(() => {
				if (!cancelled) setSlashCommands([]);
			});
		return () => {
			cancelled = true;
		};
	}, [activeSessionId]);

	/** 确保有活跃会话（无则新建），返回 sessionId */
	const ensureSession = async (): Promise<string | null> => {
		let sessionId = activeSessionId;
		if (!sessionId) {
			if (!cwd) return null;
			await createSession(cwd);
			sessionId = useSessionsStore.getState().activeSessionId;
		}
		return sessionId;
	};

	/** 执行内置命令（发送以 / 开头文本时的分发；未匹配则透传给 SDK 原生处理模板/skill/扩展命令） */
	const runSlashCommand = async (content: string, sessionId: string): Promise<boolean> => {
		const [name, ...rest] = content.slice(1).split(/\s+/);
		const arg = rest.join(" ").trim();
		const pi = getPi();
		switch (name) {
			case "compact":
				await pi.compact(sessionId, arg || undefined);
				showFeedback(t("slash.feedback.compacted"));
				return true;
			case "name":
				if (arg) {
					await pi.setSessionName(sessionId, arg);
					showFeedback(t("slash.feedback.renamed", { name: arg }));
					return true;
				}
				showFeedback(t("slash.feedback.noName"));
				return true;
			case "export": {
				const format = arg === "html" ? "html" : arg === "jsonl" ? "jsonl" : "jsonl";
				const contentOut = await pi.exportSession(sessionId, format);
				const path = await pi.saveFileDialog(`pi-session-${Date.now()}.${format}`, contentOut);
				showFeedback(path ? t("slash.feedback.exported", { path }) : t("slash.feedback.exportCancelled"));
				return true;
			}
			case "settings":
				useSettingsStore.getState().openWith();
				return true;
			default:
				// 模板/skill/扩展命令由 SDK 原生处理，原样透传
				return false;
		}
	};

	const handleSend = async () => {
		// @ 引用胶囊拼回文本：slash 胶囊时并入参数（保 /cmd 开头供 SDK 展开），否则独立成行置正文前
		const atText = attachments.map((p) => `@${p}`).join(" ");
		const content = slashCommand
			? `/${slashCommand}${atText ? ` ${atText}` : ""}${text.trim() ? ` ${text.trim()}` : ""}`
			: [atText, text.trim()].filter(Boolean).join("\n");
		// 运行中（streaming）不拦截：prompt 走 followUp 排队；仅防双击重发（sending）
		if ((!content && images.length === 0) || sending) return;
		// 单条排队上限：已有一条且本次是普通文本则挡住（斜杠命令 streaming 中也可立即执行，不受限）
		if (followUpQueue.length >= 1 && !content.startsWith("/")) {
			showFeedback(t("composer.queueFull"));
			return;
		}
		/** 发送前是否已在运行：排队失败不回滚工作中状态（run 并未受影响） */
		const wasActive = transcript.agentActive;

		let sessionId = activeSessionId;
		if (content.startsWith("/") && images.length === 0) {
			sessionId = await ensureSession();
			if (!sessionId) {
				showFeedback(t("slash.feedback.noSession"));
				return;
			}
			setText("");
			setSlashCommand(null);
			try {
				const handled = await runSlashCommand(content, sessionId);
				if (handled) return;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return;
			}
			// 未匹配的内置命令：落回正常发送（SDK 原生处理模板/技能/扩展命令）
		} else if (!sessionId) {
			if (!cwd) return;
			await createSession(cwd);
			sessionId = useSessionsStore.getState().activeSessionId;
			if (!sessionId) return;
		}

		setText("");
		setSlashCommand(null);
		setSending(true);
		setError(null);
		const sentImages = images;
		const sentAttachments = attachments;
		setImages([]);
		setAttachments([]);
		// 乐观置工作中：agent_start 事件到达前立即显示，失败后回滚
		useTranscriptStore.getState().markAgentActive(sessionId, true);
		try {
			await getPi().prompt(sessionId, content, sentImages.length > 0 ? sentImages : undefined);
		} catch (err) {
			useTranscriptStore.getState().markAgentActive(sessionId, wasActive);
			setError(err instanceof Error ? err.message : String(err));
			setImages(sentImages);
			setAttachments(sentAttachments);
		} finally {
			setSending(false);
		}
	};

	/** 停止：先清排队（避免 abort 后 SDK 把排队消息投递出去）并还原为草稿，再中止 */
	const handleStop = async () => {
		if (!activeSessionId) return;
		useTranscriptStore.getState().setFollowUpQueue(activeSessionId, []); // 乐观清面板
		const cleared = await getPi().clearQueue(activeSessionId);
		if (cleared.followUp.length > 0) {
			const restored = cleared.followUp.join("\n");
			setText((prev) => (prev ? `${prev}\n${restored}` : restored));
		}
		await getPi().abort(activeSessionId);
	};

	/** 取回排队消息：清队列（SDK 侧 queue_update 随后对齐），内容放回输入框继续编辑 */
	const handleRestoreQueue = async () => {
		if (!activeSessionId) return;
		useTranscriptStore.getState().setFollowUpQueue(activeSessionId, []); // 乐观清面板
		const cleared = await getPi().clearQueue(activeSessionId);
		const restored = cleared.followUp[0];
		if (restored) setText((prev) => (prev ? `${prev}\n${restored}` : restored));
		requestAnimationFrame(() => textareaRef.current?.focus());
	};

	/** 菜单选中命令：无参内置立即执行；带参内置/模板/技能回填继续编辑 */
	const handleSlashPick = async (command: SlashCommandInfo) => {
		if (!command.supported) return;
		const sessionId = await ensureSession();
		if (!sessionId) {
			showFeedback(t("slash.feedback.noSession"));
			return;
		}
		const inline = new Set(["compact", "settings"]);
		if (command.source === "builtin" && inline.has(command.name)) {
			setText("");
			try {
				await runSlashCommand(`/${command.name}`, sessionId);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
			return;
		}
		// 需参数/模板/skill：确认命令，输入框显示为胶囊，等待 args
		setSlashCommand(command.name);
		setText("");
		setSlashDismissed(true);
		requestAnimationFrame(() => textareaRef.current?.focus());
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

	const imageSrc = (image: ImageInput) => `data:${image.mimeType};base64,${image.data}`;

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// 空文本时 Backspace/Delete：优先把最近的 @ 胶囊弹回全路径纯文本，其次取消 slash 胶囊恢复文本
		if (
			text === "" &&
			(e.key === "Backspace" || e.key === "Delete" || (e.key === "Escape" && slashCommand))
		) {
			if (attachments.length > 0 && e.key !== "Escape") {
				e.preventDefault();
				handleAttachmentRemove(attachments.length - 1);
				return;
			}
			if (slashCommand) {
				e.preventDefault();
				setSlashCommand(null);
				setText(`/${slashCommand} `);
				setSlashDismissed(true);
				requestAnimationFrame(() => {
					const el = textareaRef.current;
					if (el) {
						el.focus();
						const len = el.value.length;
						el.setSelectionRange(len, len);
					}
				});
				return;
			}
		}
		// @ 菜单导航/选择：↑↓ 移动，Enter/Tab 选中，Esc 折叠（保留文本）
		if (atOpen && atToken) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setAtSelected((s) => s + 1);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setAtSelected((s) => s - 1);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setAtDismissed(true);
				return;
			}
			if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
				e.preventDefault();
				const path = atFiltered[Math.min(atSelected, atFiltered.length - 1)];
				if (path) handleAtPick(path);
				return;
			}
		}
		// Tab 补全选中命令（已有参数时让位默认行为）
		if (slashOpen && !slashHasArgs && e.key === "Tab") {
			e.preventDefault();
			handleSlashTabComplete();
			return;
		}
		if (slashOpen && e.key !== "Enter") {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSlashSelected((s) => s + 1);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setSlashSelected((s) => s - 1);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setText("");
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			if (slashOpen) {
				// 已带参数 → 直接发送（命令分发或模板透传）；否则选中的命令执行/回填
				if (slashHasArgs) {
					void handleSend();
				} else {
					void handleSlashPickByIndex(slashSelected);
				}
			} else {
				void handleSend();
			}
		}
	};

	/** 选中文件/目录：文件 → @ 胶囊（token 从文本移除）；目录续钻（菜单保持，query 变为目录路径） */
	const handleAtPick = (path: string) => {
		if (!atToken) return;
		const isDir = path.endsWith("/");
		const before = text.slice(0, atToken.start);
		const after = text.slice(atToken.end);
		if (!isDir) {
			// token 两侧都是空白时收掉一个，避免出现双空格
			const joined = before.endsWith(" ") && after.startsWith(" ") ? before + after.slice(1) : before + after;
			setText(joined);
			setAttachments((prev) => [...prev, path]);
			setAtToken(null);
			const cursor = before.length;
			requestAnimationFrame(() => {
				const el = textareaRef.current;
				if (el) {
					el.focus();
					el.setSelectionRange(cursor, cursor);
				}
			});
			return;
		}
		const insert = `@${path}`;
		setText(before + insert + after);
		const cursor = (before + insert).length;
		setAtToken({ start: atToken.start, end: cursor, query: path });
		requestAnimationFrame(() => {
			const el = textareaRef.current;
			if (el) {
				el.focus();
				el.setSelectionRange(cursor, cursor);
			}
		});
	};

	/** 移除 @ 胶囊：恢复为全路径纯文本（追加到文本末尾，与 slash 胶囊删除恢复同逻辑） */
	const handleAttachmentRemove = (index: number) => {
		const path = attachments[index];
		if (!path) return;
		setAttachments((prev) => prev.filter((_, i) => i !== index));
		setText((prev) => (prev ? `${prev} @${path} ` : `@${path} `));
		requestAnimationFrame(() => {
			const el = textareaRef.current;
			if (el) {
				el.focus();
				const len = el.value.length;
				el.setSelectionRange(len, len);
			}
		});
	};

	/** 按下标选中菜单项（无匹配时落回正常发送） */
	const handleSlashPickByIndex = (index: number) => {
		const flat = filterCommands(slashCommands, slashQuery);
		const command = flat[Math.min(index, flat.length - 1)] ?? undefined;
		if (command) {
			void handleSlashPick(command);
		} else {
			void handleSend();
		}
	};

	/** Tab 补全：确认选中命令为胶囊（args 留空待输入），菜单随之关闭 */
	const handleSlashTabComplete = () => {
		const flat = filterCommands(slashCommands, slashQuery);
		if (flat.length === 0) return;
		const command = flat[Math.min(slashSelected, flat.length - 1)] ?? flat[0];
		if (!command) return;
		setSlashCommand(command.name);
		setText("");
		setSlashSelected(0);
		setSlashDismissed(false);
		requestAnimationFrame(() => textareaRef.current?.focus());
	};

	return (
		<div ref={boxRef} className={centered ? "w-full max-w-[760px]" : "shrink-0 px-6 pb-3"}>
			<div className="mx-auto max-w-[760px]">
				{error && <p className="mb-1.5 text-xs text-red-500">{error}</p>}
				{feedback && !error && <p className="mb-1.5 text-xs text-green-600">{feedback}</p>}
				{slashOpen && (
					<SlashMenu
						commands={slashCommands}
						query={slashQuery}
						selectedIndex={slashSelected}
						onSelectedIndexChange={setSlashSelected}
						onPick={(command) => void handleSlashPick(command)}
					/>
				)}
				{atOpen && (
					<AtMenu
						files={atFiltered}
						selectedIndex={atSelected}
						onSelectedIndexChange={setAtSelected}
						onPick={handleAtPick}
					/>
				)}
				{followUpQueue.length > 0 && (
					<div className="group/queue relative mb-1.5 flex items-center gap-2 overflow-hidden rounded-xl bg-surface px-3 py-1.5 shadow-soft">
						<span className="shrink-0 text-[12px] text-ink-faint">{t("composer.queueTitle")}</span>
						<span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{followUpQueue[0]}</span>
						{/* 撤销层：hover 行才显示；渐变模糊压住下方文字，仅镂空图标可点（防误点） */}
						<div className="pointer-events-none absolute inset-y-0 right-0 flex w-14 items-center justify-end pr-2.5 opacity-0 transition-opacity group-hover/queue:opacity-100">
							<span
								className="absolute inset-0 bg-gradient-to-l from-surface/60 to-transparent backdrop-blur-[3px] [mask-image:linear-gradient(to_left,black_45%,transparent)]"
								aria-hidden="true"
							/>
							<button
								type="button"
								className="pointer-events-auto relative flex items-center justify-center text-ink-faint transition-colors hover:text-ink-2"
								aria-label={t("composer.queueRestore")}
								onClick={() => void handleRestoreQueue()}
							>
								<UndoIcon size={14} />
							</button>
						</div>
					</div>
				)}
				{images.length > 0 && (
					<div className="mb-1.5 flex flex-wrap items-end gap-2">
						{images.map((image, index) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: 缩略图列表不可变（删除为整列表替换）
								key={index}
								className="group relative"
							>
								<button
									type="button"
									className="block h-16 w-16 overflow-hidden rounded-lg border border-border bg-surface"
									onClick={() => setPreviewImage(image)}
								>
									<img
										src={imageSrc(image)}
										alt={`${t("composer.previewImage")} ${index + 1}`}
										className="h-full w-full object-cover"
									/>
								</button>
								<button
									type="button"
									className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-ink text-on-ink shadow transition-colors hover:bg-red-600"
									aria-label={t("composer.removeImage")}
									onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
								>
									<CloseIcon size={8} />
								</button>
							</div>
						))}
					</div>
				)}
				<div className="rounded-2xl border-[0.5px] border-border bg-surface shadow-soft">
					{slashCommand || attachments.length > 0 ? (
						<div className="flex flex-wrap items-start gap-1.5 px-4 pt-5 pb-2">
							{slashCommand && (
								<span className="mt-0.5 shrink-0 select-none rounded-md bg-border px-2 py-0.5 font-mono text-[12px] leading-5 text-ink-2">
									/{slashCommand}
								</span>
							)}
							{attachments.map((path, index) => (
								<AttachmentChip key={path} path={path} onRemove={() => handleAttachmentRemove(index)} />
							))}
							<textarea
								ref={textareaRef}
								className="max-h-[200px] min-w-[140px] flex-1 resize-none bg-transparent pt-0.5 text-[14px] leading-relaxed outline-none placeholder:text-ink-faint select-text"
								placeholder={slashCommand ? t("slash.argPlaceholder") : t("composer.placeholder")}
								value={text}
								rows={1}
								onChange={handleTextChange}
								onKeyDown={handleKeyDown}
								onPaste={handlePaste}
							/>
						</div>
					) : (
						<textarea
							ref={textareaRef}
							className="max-h-[200px] w-full resize-none rounded-t-2xl px-4 pt-5 pb-2 text-[14px] leading-relaxed bg-transparent outline-none placeholder:text-ink-faint select-text"
							placeholder={isStreaming ? t("composer.placeholderQueued") : t("composer.placeholder")}
							value={text}
							rows={1}
							onChange={handleTextChange}
							onKeyDown={handleKeyDown}
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
							onClick={() => fileInputRef.current?.click()}
						>
							<PlusIcon size={18} />
						</button>
						<ContextRing />
						<div className="flex-1" />
						<ModelPicker />
						<ThinkingPicker />
						{isStreaming && !hasContent ? (
							<button
								type="button"
								className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-on-ink transition-colors hover:bg-red-600"
								onClick={() => void handleStop()}
								aria-label={t("composer.stop")}
							>
								<StopIcon />
							</button>
						) : (
							<button
								type="button"
								className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-on-ink transition-colors hover:bg-ink-2 disabled:opacity-30"
								disabled={!hasContent || sending}
								onClick={() => void handleSend()}
								aria-label={t("composer.send")}
							>
								<ArrowUpIcon size={20} />
							</button>
						)}
					</div>
				</div>
			</div>
			{previewImage && (
				<button
					type="button"
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
					onClick={() => setPreviewImage(null)}
				>
					<img
						src={imageSrc(previewImage)}
						alt={t("composer.previewImage")}
						className="max-h-full max-w-full rounded-lg object-contain"
					/>
				</button>
			)}
		</div>
	);
}

/** @ 文件引用胶囊：淡蓝底色；路径超长时 RTL 截断（优先保留文件名端），× 移除并恢复全路径纯文本。
   仅截断时挂 Tooltip 显示全路径（未截断内容与胶囊重复，不显示） */
function AttachmentChip({ path, onRemove }: { path: string; onRemove: () => void }) {
	const t = useT();
	const pathRef = useRef<HTMLSpanElement>(null);
	const [truncated, setTruncated] = useState(false);

	// chip 由父级 key={path} 保证换路径即重挂载；RO 覆盖窗口缩放引起的截断变化
	useEffect(() => {
		const el = pathRef.current;
		if (!el) return;
		const check = () => setTruncated(el.scrollWidth > el.clientWidth);
		check();
		const ro = new ResizeObserver(check);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const chip = (
		<span className="mt-0.5 flex max-w-[220px] select-none items-center gap-1 rounded-md bg-blue-500/10 px-2 py-0.5 font-mono text-[12px] leading-5 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300">
			<span aria-hidden="true">@</span>
			<span ref={pathRef} className="min-w-0 truncate" style={{ direction: "rtl", textAlign: "left" }}>
				{path}
			</span>
			<button
				type="button"
				aria-label={t("composer.removeAttachment")}
				onClick={onRemove}
				className="shrink-0 text-blue-400 transition-colors hover:text-blue-600 dark:hover:text-blue-200"
			>
				<CloseIcon size={8} />
			</button>
		</span>
	);
	return truncated ? <Tooltip label={path}>{chip}</Tooltip> : chip;
}
