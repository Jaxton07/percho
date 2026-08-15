import type { ImageInput } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { isDraftSessionId, useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useTranscriptStore } from "../../stores/transcript";

export interface UseComposerSendOptions {
	activeSessionId: string | null;
	text: string;
	images: ImageInput[];
	attachments: string[];
	slashCommand: string | null;
	followUpQueue: string[];
	/** 压缩进行中（禁发：SDK 拒绝压缩中的 prompt） */
	compacting: boolean;
	/** 发送前会话是否已在运行（排队失败不回滚工作中状态） */
	agentActive: boolean;
	setText: (updater: string | ((prev: string) => string)) => void;
	setImages: (updater: ImageInput[] | ((prev: ImageInput[]) => ImageInput[])) => void;
	setAttachments: (updater: string[] | ((prev: string[]) => string[])) => void;
	setSlashCommand: (command: string | null) => void;
}

/**
 * 发送域：会话确保/建链、发送（含斜杠命令分发）、停止、排队取回。
 * sending/error/feedback 状态也在此（与发送动作同生命周期）。
 */
export function useComposerSend(options: UseComposerSendOptions) {
	const t = useT();
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<{ message: string; tone: "info" | "warn" } | null>(null);
	const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const showFeedback = (message: string, tone: "info" | "warn" = "info") => {
		setFeedback({ message, tone });
		if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
		feedbackTimer.current = setTimeout(() => setFeedback(null), 2500);
	};

	/** 确保有活跃会话（无会话或 draft 时用其 cwd 真正创建，draft tab 原地转正），返回 sessionId */
	const ensureSession = async (): Promise<string | null> => {
		const state = useSessionsStore.getState();
		const current = state.activeSessionId;
		if (current && !isDraftSessionId(current)) return current;
		const draftCwd = current ? state.sessions.find((s) => s.sessionId === current)?.cwd : undefined;
		const targetCwd = draftCwd ?? state.cwd;
		if (!targetCwd) return null;
		await useSessionsStore.getState().createSession(targetCwd, current ?? undefined);
		const created = useSessionsStore.getState().activeSessionId;
		return created && !isDraftSessionId(created) ? created : null;
	};

	/** 执行内置命令（发送以 / 开头文本时的分发；未匹配则透传给 SDK 原生处理模板/skill/扩展命令） */
	const runSlashCommand = async (content: string, sessionId: string): Promise<boolean> => {
		const [name, ...rest] = content.slice(1).split(/\s+/);
		const arg = rest.join(" ").trim();
		const pi = getPi();
		switch (name) {
			case "compact":
				// 失败不在输入框上方报错：对话区压缩分割线（compaction_end error）已完整呈现
				try {
					await pi.compact(sessionId, arg || undefined);
					showFeedback(t("slash.feedback.compacted"));
				} catch {
					// 静默，理由见上
				}
				return true;
			case "name":
				if (arg) {
					await pi.setSessionName(sessionId, arg);
					showFeedback(t("slash.feedback.renamed", { name: arg }));
					return true;
				}
				showFeedback(t("slash.feedback.noName"), "warn");
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
		const { text, images, attachments, slashCommand, followUpQueue, compacting, agentActive } = options;
		// @ 引用胶囊拼回文本：slash 胶囊时并入参数（保 /cmd 开头供 SDK 展开），否则独立成行置正文前
		const atText = attachments.map((p) => `@${p}`).join(" ");
		const content = slashCommand
			? `/${slashCommand}${atText ? ` ${atText}` : ""}${text.trim() ? ` ${text.trim()}` : ""}`
			: [atText, text.trim()].filter(Boolean).join("\n");
		// 运行中（streaming）不拦截：prompt 走 followUp 排队；仅防双击重发（sending）
		if ((!content && images.length === 0) || sending) return;
		// 压缩中禁发：SDK 拒绝压缩中的 prompt，提前拦截保住草稿
		if (compacting) {
			showFeedback(t("composer.compacting"), "warn");
			return;
		}
		// 单条排队上限：已有一条且本次是普通文本则挡住（斜杠命令 streaming 中也可立即执行，不受限）
		if (followUpQueue.length >= 1 && !content.startsWith("/")) {
			showFeedback(t("composer.queueFull"), "warn");
			return;
		}
		const wasActive = agentActive;

		let sessionId = options.activeSessionId;
		if (content.startsWith("/") && images.length === 0) {
			sessionId = await ensureSession();
			if (!sessionId) {
				showFeedback(t("slash.feedback.noSession"), "warn");
				return;
			}
			options.setText("");
			options.setSlashCommand(null);
			try {
				const handled = await runSlashCommand(content, sessionId);
				if (handled) return;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return;
			}
			// 未匹配的内置命令：落回正常发送（SDK 原生处理模板/技能/扩展命令）
		} else if (!sessionId || isDraftSessionId(sessionId)) {
			// 无会话或 draft tab：用其 cwd 真正创建（draft 原地转正）
			sessionId = await ensureSession();
			if (!sessionId) return;
		}

		options.setText("");
		options.setSlashCommand(null);
		setSending(true);
		setError(null);
		const sentImages = images;
		const sentAttachments = attachments;
		options.setImages([]);
		options.setAttachments([]);
		// 乐观置工作中：agent_start 事件到达前立即显示，失败后回滚
		useTranscriptStore.getState().markAgentActive(sessionId, true);
		try {
			await getPi().prompt(sessionId, content, sentImages.length > 0 ? sentImages : undefined);
		} catch (err) {
			useTranscriptStore.getState().markAgentActive(sessionId, wasActive);
			setError(err instanceof Error ? err.message : String(err));
			options.setImages(sentImages);
			options.setAttachments(sentAttachments);
		} finally {
			setSending(false);
		}
	};

	/** 停止：先清排队（避免 abort 后 SDK 把排队消息投递出去）并还原为草稿，再中止 */
	const handleStop = async () => {
		const { activeSessionId, setText } = options;
		if (!activeSessionId || isDraftSessionId(activeSessionId)) return;
		useTranscriptStore.getState().setFollowUpQueue(activeSessionId, []); // 乐观清面板
		const cleared = await getPi().clearQueue(activeSessionId);
		if (cleared.followUp.length > 0) {
			const restored = cleared.followUp.join("\n");
			setText((prev) => (prev ? `${prev}\n${restored}` : restored));
		}
		await getPi().abort(activeSessionId);
	};

	/** 取回排队消息：清队列（SDK 侧 queue_update 随后对齐），内容放回输入框继续编辑 */
	const handleRestoreQueue = async (focus: () => void) => {
		const { activeSessionId, setText } = options;
		if (!activeSessionId || isDraftSessionId(activeSessionId)) return;
		useTranscriptStore.getState().setFollowUpQueue(activeSessionId, []); // 乐观清面板
		const cleared = await getPi().clearQueue(activeSessionId);
		const restored = cleared.followUp[0];
		if (restored) setText((prev) => (prev ? `${prev}\n${restored}` : restored));
		requestAnimationFrame(focus);
	};

	// 卸载时清反馈计时器，防 setState on unmounted
	useEffect(() => {
		return () => {
			if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
		};
	}, []);

	return {
		sending,
		error,
		setError,
		feedback,
		showFeedback,
		ensureSession,
		runSlashCommand,
		handleSend,
		handleStop,
		handleRestoreQueue,
	};
}
