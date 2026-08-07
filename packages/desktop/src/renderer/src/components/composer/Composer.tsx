import type { ImageInput } from "@pi-desktop/shared";
import { useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";
import { ArrowUpIcon, CloseIcon, PlusIcon, StopIcon } from "../icons";
import { ModelPicker } from "./ModelPicker";
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
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const isStreaming = transcript.phase === "streaming" || sending;

	// biome-ignore lint/correctness/useExhaustiveDependencies: 高度由文本 DOM 变化驱动，显式依赖 text 便于触发
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}, [text]);

	const handleSend = async () => {
		const content = text.trim();
		if ((!content && images.length === 0) || isStreaming) return;

		let sessionId = activeSessionId;
		if (!sessionId) {
			if (!cwd) return;
			await createSession(cwd);
			sessionId = useSessionsStore.getState().activeSessionId;
			if (!sessionId) return;
		}

		setText("");
		setSending(true);
		setError(null);
		const sentImages = images;
		setImages([]);
		try {
			await getPi().prompt(sessionId, content, sentImages.length > 0 ? sentImages : undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setImages(sentImages);
		} finally {
			setSending(false);
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

	const imageSrc = (image: ImageInput) => `data:${image.mimeType};base64,${image.data}`;

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void handleSend();
		}
	};

	return (
		<div className={centered ? "w-full max-w-[760px]" : "shrink-0 px-6 pb-3"}>
			<div className="mx-auto max-w-[760px]">
				{error && <p className="mb-1.5 text-xs text-red-500">{error}</p>}
				{images.length > 0 && (
					<div className="mb-1.5 flex flex-wrap items-end gap-2">
						{images.map((image, index) => (
							<div key={index} className="group relative">
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
					<textarea
						ref={textareaRef}
						className="max-h-[200px] w-full resize-none rounded-t-2xl px-4 pt-5 pb-2 text-[14px] leading-relaxed bg-transparent outline-none placeholder:text-zinc-400 select-text"
						placeholder={t("composer.placeholder")}
						value={text}
						rows={1}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
					/>
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
						<div className="flex-1" />
						<ModelPicker />
						<ThinkingPicker />
						{isStreaming ? (							<button
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
								disabled={(!text.trim() && images.length === 0) || isStreaming}
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
