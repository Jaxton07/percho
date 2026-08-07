import { useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";
import { ArrowUpIcon, StopIcon } from "../icons";

/** 底部输入框：自动增高、Enter 发送、生成中变停止；centered 用于空态居中布局 */
export function Composer({ centered = false }: { centered?: boolean }) {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const cwd = useSessionsStore((s) => s.cwd);
	const createSession = useSessionsStore((s) => s.createSession);
	const transcript = useTranscriptStore((s) => selectTranscript(s, activeSessionId));
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

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
		if (!content || isStreaming) return;

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
		try {
			await getPi().prompt(sessionId, content);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSending(false);
		}
	};

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
				<div className="rounded-2xl border border-zinc-200 bg-white shadow-sm focus-within:border-zinc-400">
					<textarea
						ref={textareaRef}
						className="max-h-[200px] w-full resize-none rounded-t-2xl px-4 pt-5 pb-2 text-[14px] leading-relaxed bg-transparent outline-none placeholder:text-zinc-400 select-text"
						placeholder={t("composer.placeholder")}
						value={text}
						rows={1}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={handleKeyDown}
					/>
					<div className="flex items-center gap-2 px-3 pb-2">
						<div className="flex-1" />
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
								disabled={!text.trim() || isStreaming}
								onClick={() => void handleSend()}
								title={t("composer.send")}
								aria-label={t("composer.send")}
							>
								<ArrowUpIcon size={16} />
							</button>
						)}
					</div>
				</div>
				<p className="mt-1 text-center text-[10px] text-zinc-300">{t("composer.hint")}</p>
			</div>
		</div>
	);
}
