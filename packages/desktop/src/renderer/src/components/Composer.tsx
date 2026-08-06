import { useEffect, useRef, useState } from "react";
import { getPi } from "../api";
import { useSessionsStore } from "../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../stores/transcript";

/** 底部输入框：自动增高、Enter 发送、生成中变停止 */
export function Composer() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const cwd = useSessionsStore((s) => s.cwd);
	const createSession = useSessionsStore((s) => s.createSession);
	const pickDirectory = useSessionsStore((s) => s.pickDirectory);
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
			if (!cwd) {
				await pickDirectory();
			}
			const target = useSessionsStore.getState().cwd;
			if (!target) return;
			await createSession(target);
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
		<div className="shrink-0 px-6 pb-3">
			<div className="mx-auto max-w-[760px]">
				{error && <p className="mb-1.5 text-xs text-red-500">{error}</p>}
				<div className="rounded-2xl border border-zinc-200 bg-white shadow-sm focus-within:border-zinc-400">
					<textarea
						ref={textareaRef}
						className="max-h-[200px] w-full resize-none rounded-t-2xl px-4 pt-3.5 pb-1 text-[14px] leading-relaxed bg-transparent outline-none placeholder:text-zinc-400 select-text"
						placeholder="随便问点什么，/ 命令，@ 上下文"
						value={text}
						rows={1}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={handleKeyDown}
					/>
					<div className="flex items-center gap-2 px-3 pb-2">
						<span className="rounded-md border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-500">
							Build
						</span>
						<button
							type="button"
							className="rounded-md px-1.5 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-50 hover:text-zinc-600"
							onClick={() => void pickDirectory()}
							title="切换工作目录"
						>
							{cwd ? cwd.split("/").filter(Boolean).pop() : "选择目录"}
						</button>
						<div className="flex-1" />
						{isStreaming ? (
							<button
								type="button"
								className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-white transition-colors hover:bg-red-600"
								onClick={() => {
									if (activeSessionId) void getPi().abort(activeSessionId);
								}}
								title="停止"
								aria-label="停止"
							>
								<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
									<rect x="0" y="0" width="10" height="10" rx="1.5" />
								</svg>
							</button>
						) : (
							<button
								type="button"
								className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-white transition-colors hover:bg-zinc-700 disabled:opacity-30"
								disabled={!text.trim() || isStreaming}
								onClick={() => void handleSend()}
								title="发送"
								aria-label="发送"
							>
								<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
									<path d="M2 1.5l8 4.5-8 4.5v-3.6l5-0.9-5-0.9z" fill="currentColor" />
								</svg>
							</button>
						)}
					</div>
				</div>
				<p className="mt-1 text-center text-[10px] text-zinc-300">Enter 发送 · Shift+Enter 换行</p>
			</div>
		</div>
	);
}
