import type { ImageInput, SlashCommandInfo } from "@pi-desktop/shared";
import { useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";
import { ArrowUpIcon, CloseIcon, PlusIcon, StopIcon } from "../icons";
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
	const [text, setText] = useState("");
	const [images, setImages] = useState<ImageInput[]>([]);
	const [previewImage, setPreviewImage] = useState<ImageInput | null>(null);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<string | null>(null);
	const [slashSelected, setSlashSelected] = useState(0);
	const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
	/** Tab/点击回填后确认的命令名：输入框显示为灰色胶囊，args 为普通文本 */
	const [slashCommand, setSlashCommand] = useState<string | null>(null);
	/** 点击面板外部后隐藏菜单（保留文本，再次输入时恢复） */
	const [slashDismissed, setSlashDismissed] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const isStreaming = transcript.phase === "streaming" || sending;
	/** 输入以 / 开头时打开命令面板；query = 第一个词（/ 后） */
	const slashOpen = text.startsWith("/") && !slashDismissed;
	const slashQuery = slashOpen ? (text.slice(1).split(" ")[0] ?? "") : "";
	/** trim 后是否已带参数（Enter 时决定执行还是选中） */
	const slashHasArgs = slashOpen && text.trim().includes(" ");

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

	// 点击输入框容器外部时收起命令面板（文本保留；继续输入时恢复）
	useEffect(() => {
		if (!slashOpen) return;
		const onPointerDown = (e: PointerEvent) => {
			if (boxRef.current && !boxRef.current.contains(e.target as Node)) setSlashDismissed(true);
		};
		window.addEventListener("pointerdown", onPointerDown);
		return () => window.removeEventListener("pointerdown", onPointerDown);
	}, [slashOpen]);

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
				if (!arg) {
					await pi.compact(sessionId);
					showFeedback(t("slash.feedback.compacted"));
					return true;
				}
				return false;
			case "name":
				if (arg) {
					await pi.setSessionName(sessionId, arg);
					showFeedback(t("slash.feedback.renamed", { name: arg }));
					return true;
				}
				showFeedback(t("slash.feedback.noName"));
				return true;
			case "copy": {
				const msgs = useTranscriptStore.getState().bySession[sessionId]?.messages ?? [];
				let lastText = "";
				for (const m of [...msgs].reverse()) {
					if (m.kind === "assistant" && m.text) {
						lastText = m.text;
						break;
					}
				}
				if (lastText) {
					await navigator.clipboard.writeText(lastText);
					showFeedback(t("slash.feedback.copied"));
				} else {
					showFeedback(t("slash.feedback.noCopy"));
				}
				return true;
			}
			case "export": {
				const format = arg === "html" ? "html" : arg === "jsonl" ? "jsonl" : "jsonl";
				const contentOut = await pi.exportSession(sessionId, format);
				const path = await pi.saveFileDialog(`pi-session-${Date.now()}.${format}`, contentOut);
				showFeedback(path ? t("slash.feedback.exported", { path }) : t("slash.feedback.exportCancelled"));
				return true;
			}
			case "new":
				if (!arg) {
					await createSession(cwd ?? undefined);
					return true;
				}
				return false;
			case "settings":
				if (!arg) {
					useSettingsStore.getState().openWith();
					return true;
				}
				return false;
			case "login":
				useSettingsStore.getState().openWith("providers");
				return true;
			default:
				// 模板/skill/扩展命令由 SDK 原生处理，原样透传
				return false;
		}
	};

	const handleSend = async () => {
		// 胶囊确认的命令 + args 拼回原始 /cmd 形式
		const content = slashCommand ? `/${slashCommand}${text.trim() ? ` ${text.trim()}` : ""}` : text.trim();
		if ((!content && images.length === 0) || isStreaming) return;

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
		setImages([]);
		// 乐观置工作中：agent_start 事件到达前立即显示，失败后回滚
		useTranscriptStore.getState().markAgentActive(sessionId, true);
		try {
			await getPi().prompt(sessionId, content, sentImages.length > 0 ? sentImages : undefined);
		} catch (err) {
			useTranscriptStore.getState().markAgentActive(sessionId, false);
			setError(err instanceof Error ? err.message : String(err));
			setImages(sentImages);
		} finally {
			setSending(false);
		}
	};

	/** 菜单选中命令：无参内置立即执行；带参内置/模板/技能回填继续编辑 */
	const handleSlashPick = async (command: SlashCommandInfo) => {
		if (!command.supported) return;
		const sessionId = await ensureSession();
		if (!sessionId) {
			showFeedback(t("slash.feedback.noSession"));
			return;
		}
		const inline = new Set(["compact", "copy", "new", "settings", "login"]);
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
		// 胶囊模式下 args 为空时，Backspace/Delete/Escape 取消命令（恢复文本，菜单不重新弹出）
		if (slashCommand && text === "") {
			if (e.key === "Backspace" || e.key === "Delete" || e.key === "Escape") {
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
									className="block h-16 w-16 overflow-hidden rounded-lg border border-zinc-200 bg-white"
									title={t("composer.previewImage")}
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
									className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-zinc-800 text-white shadow transition-colors hover:bg-red-600"
									title={t("composer.removeImage")}
									aria-label={t("composer.removeImage")}
									onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
								>
									<CloseIcon size={8} />
								</button>
							</div>
						))}
					</div>
				)}
				<div className="rounded-2xl border-[0.5px] border-zinc-200 bg-white shadow-[0_0_14px_-2px_rgba(24,24,27,0.08)]">
					{slashCommand ? (
						<div className="flex items-start gap-1.5 px-4 pt-5 pb-2">
							<span className="mt-0.5 shrink-0 select-none rounded-md bg-zinc-200 px-2 py-0.5 font-mono text-[12px] leading-5 text-zinc-700">
								/{slashCommand}
							</span>
							<textarea
								ref={textareaRef}
								className="max-h-[200px] flex-1 resize-none bg-transparent pt-0.5 text-[14px] leading-relaxed outline-none placeholder:text-zinc-400 select-text"
								placeholder={t("slash.argPlaceholder")}
								value={text}
								rows={1}
								onChange={(e) => {
									setSlashDismissed(false);
									setText(e.target.value);
								}}
								onKeyDown={handleKeyDown}
								onPaste={handlePaste}
							/>
						</div>
					) : (
						<textarea
							ref={textareaRef}
							className="max-h-[200px] w-full resize-none rounded-t-2xl px-4 pt-5 pb-2 text-[14px] leading-relaxed bg-transparent outline-none placeholder:text-zinc-400 select-text"
							placeholder={t("composer.placeholder")}
							value={text}
							rows={1}
							onChange={(e) => {
								setSlashDismissed(false);
								setText(e.target.value);
							}}
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
							className="-ml-1 -mb-1 flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
							title={t("composer.addImage")}
							aria-label={t("composer.addImage")}
							onClick={() => fileInputRef.current?.click()}
						>
							<PlusIcon size={18} />
						</button>
						<ContextRing />
						<div className="flex-1" />
						<ModelPicker />
						<ThinkingPicker />
						{isStreaming ? (
							<button
								type="button"
								className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-white transition-colors hover:bg-red-600"
								onClick={() => {
									if (activeSessionId) void getPi().abort(activeSessionId);
								}}
								title={t("composer.stop")}
								aria-label={t("composer.stop")}
							>
								<StopIcon />
							</button>
						) : (
							<button
								type="button"
								className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-white transition-colors hover:bg-zinc-700 disabled:opacity-30"
								disabled={(!text.trim() && images.length === 0 && !slashCommand) || isStreaming}
								onClick={() => void handleSend()}
								title={t("composer.send")}
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
					title={t("common.close")}
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
