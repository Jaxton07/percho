import {
	type ComposerDocument,
	composerDocumentFromText,
	composerDocumentText,
	normalizeComposerDocument,
} from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { getExecutionApi } from "../../environment-api";
import { useT } from "../../i18n";
import {
	appendDraftInput,
	type DraftEntry,
	draftText,
	EMPTY_DRAFT,
	newSessionDraftKey,
	restoreRejectedDraft,
	takeDraft,
	useDraftStore,
} from "../../stores/drafts";
import { isSessionSynchronizing } from "../../stores/session-event-boundary";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { pushToast } from "../../stores/toasts";
import { useTranscriptStore } from "../../stores/transcript";
import { buildQuoteBlock } from "./quote";
import { buildSendUiError } from "./send-error";
import { createSendGuard } from "./send-guard";

export interface UseComposerSendOptions {
	draftKey: string;
	activeSessionId: string | null;
	/** 当前模型是否支持图片输入（fail-open：未知按支持）；false 且草稿有图时拦截发送 */
	imagesSupported: boolean;
}

/**
 * 发送域：会话确保/建链、发送（含斜杠命令分发）、停止、排队取回。
 * sending/error/feedback 状态也在此（与发送动作同生命周期）。
 */
export function useComposerSend(options: UseComposerSendOptions) {
	const t = useT();
	const sending = useDraftStore((s) => s.pendingBySession[options.draftKey] === true);
	const error = useDraftStore((s) => s.errorsBySession[options.draftKey] ?? null);
	const [feedback, setFeedback] = useState<{ message: string; tone: "info" | "warn" } | null>(null);
	const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** 发送的同步锁（见 send-guard.ts：state 挡不住 await 窗口里的重复触发） */
	const sendGuard = useRef(createSendGuard());

	/** 统一信封：发送失败也走 UiError（内联条 + 与消息流错误卡同语言）；传 null 清除 */
	const setError = (message: string | null, key = options.draftKey) =>
		useDraftStore.setState((s) => ({
			errorsBySession: { ...s.errorsBySession, [key]: message ? buildSendUiError(message) : undefined },
		}));
	const setPending = (key: string, pending: boolean) =>
		useDraftStore.setState((s) => {
			const next = { ...s.pendingBySession };
			if (pending) next[key] = true;
			else delete next[key];
			return { pendingBySession: next };
		});

	const showFeedback = (message: string, tone: "info" | "warn" = "info") => {
		setFeedback({ message, tone });
		if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
		feedbackTimer.current = setTimeout(() => setFeedback(null), 2500);
	};

	/** 确保有活跃会话（新会话页则把那唯一一份 draft 转正），返回 sessionId */
	const ensureSession = async (): Promise<string | null> => {
		const current = options.activeSessionId;
		if (current) {
			if (isSessionSynchronizing(current)) throw new Error(t("remote.synchronizing"));
			return current;
		}
		// draft 页：promotion 用 draft 快照建真实会话（模型/思考/权限都从 `newSessionDraft` 取，
		// 调用方不再自己拼 cwd/权限）。无 draft 的防御态（调用顺序异常）先建一份再转正。
		if (!useSessionsStore.getState().newSessionDraft) {
			useSessionsStore.getState().activateNewSessionDraft();
		}
		// 用返回值定位新会话，不读 activeSessionId：创建期间用户可能已切走，
		// 此时新会话仍在后台存在（latest-wins 不让它抢焦点），读 active 会把消息发到别人身上
		return useSessionsStore.getState().createSession();
	};

	/** 执行内置命令（发送以 / 开头文本时的分发；未匹配则透传给 SDK 原生处理模板/skill/扩展命令） */
	const runSlashCommand = async (content: string, sessionId: string): Promise<boolean> => {
		const [name, ...rest] = content.slice(1).split(/\s+/);
		const arg = rest.join(" ").trim();
		const pi = getExecutionApi(sessionId);
		switch (name) {
			case "compact":
				// 输入框上方不提醒（成功/失败都不提醒）：对话区的压缩分割线已经把「在干什么、成没成」说全了
				try {
					await pi.compact({ sessionId, customInstructions: arg || undefined });
				} catch {
					// 静默，理由见上
				}
				return true;
			case "name":
				if (arg) {
					await pi.setSessionName({ sessionId, name: arg });
					showFeedback(t("slash.feedback.renamed", { name: arg }));
					return true;
				}
				showFeedback(t("slash.feedback.noName"), "warn");
				return true;
			case "export": {
				const format = arg === "html" ? "html" : arg === "jsonl" ? "jsonl" : "jsonl";
				const contentOut = await pi.exportSession({ sessionId, format });
				const path = await getPi().saveFileDialog({
					defaultName: `pi-session-${Date.now()}.${format}`,
					content: contentOut,
				});
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

	/**
	 * 真正的一轮发送（同步锁内）。从「确保有会话」到 prompt 落地都可能 await，
	 * 调用方必须先抢 `sendGuard` 再进来（见 handleSend 尾部的注释）。
	 */
	const sendNow = async (sent: {
		content: string;
		document?: ComposerDocument;
		draft: DraftEntry;
		generation: number | undefined;
		wasActive: boolean;
	}): Promise<void> => {
		const { content, document, draft, generation, wasActive } = sent;
		let sessionId = options.activeSessionId;
		let recoveryKey = options.draftKey;
		let optimisticId: string | null = null;
		let markedActive = false;
		setPending(options.draftKey, true);
		setError(null);
		try {
			if (!sessionId) {
				const target = useSessionsStore.getState().newSessionDraft;
				if (
					target?.generation !== generation ||
					newSessionDraftKey(target?.environment, target?.cwd) !== options.draftKey
				) {
					throw new Error(t("composer.targetChanged"));
				}
				sessionId = await ensureSession();
				if (!sessionId) throw new Error(t("slash.feedback.noSession"));
				recoveryKey = sessionId;
				setPending(recoveryKey, true);
			}
			if (
				!document &&
				content.startsWith("/") &&
				draft.images.length === 0 &&
				(await runSlashCommand(content, sessionId))
			)
				return;
			useTranscriptStore.getState().markAgentActive(sessionId, true);
			markedActive = true;
			optimisticId =
				wasActive || (!document && content.startsWith("/"))
					? null
					: useTranscriptStore
							.getState()
							.appendOptimisticUser(sessionId, { text: content, images: draft.images, document });
			await getExecutionApi(sessionId).prompt({
				sessionId,
				text: content,
				document,
				images: draft.images.length ? draft.images : undefined,
			});
		} catch (error) {
			if (sessionId && markedActive) {
				if (optimisticId) useTranscriptStore.getState().removeOptimisticUser(sessionId, optimisticId);
				useTranscriptStore.getState().markAgentActive(sessionId, wasActive);
			}
			const newGeneration = useSessionsStore.getState().newSessionDraft?.generation;
			restoreRejectedDraft(
				recoveryKey,
				draft,
				!options.activeSessionId && recoveryKey === options.draftKey && generation !== newGeneration,
			);
			setError(error instanceof Error ? error.message : String(error), recoveryKey);
		} finally {
			setPending(options.draftKey, false);
			if (recoveryKey !== options.draftKey) setPending(recoveryKey, false);
		}
	};

	const handleSend = async () => {
		// 图片准备可能跨越导航或一轮运行结束；发送检查读取原目标的当前状态。
		const current = options.activeSessionId
			? useTranscriptStore.getState().bySession[options.activeSessionId]
			: undefined;
		const followUpQueue = current?.followUpQueue ?? [];
		const compacting = current?.compacting ?? false;
		const agentActive = current?.agentActive ?? false;
		const currentDraft = useDraftStore.getState().bySession[options.draftKey] ?? EMPTY_DRAFT;
		const { images, quotes, slashCommand } = currentDraft;
		const text = draftText(currentDraft);
		// 选区引用置于正文前；文件和 skill 保留在正文原位置。
		const quoteBlock = buildQuoteBlock(quotes);
		const body = text.trim();
		let content = [quoteBlock, slashCommand ? `/${slashCommand}${body ? ` ${body}` : ""}` : body]
			.filter(Boolean)
			.join("\n\n");
		const hasReferences = currentDraft.document.parts.some((p) => p.type !== "text");
		const prefix = [quoteBlock ? `${quoteBlock}\n\n` : "", slashCommand ? `/${slashCommand} ` : ""].join("");
		const document = hasReferences
			? normalizeComposerDocument({
					version: 1,
					parts: [{ type: "text", text: prefix }, ...currentDraft.document.parts],
				})
			: undefined;
		if (document) content = composerDocumentText(document);
		// 运行中（streaming）不拦截：prompt 走 followUp 排队；仅防双击重发（sending）
		if ((!content && images.length === 0) || useDraftStore.getState().pendingBySession[options.draftKey])
			return;
		// 压缩中禁发：SDK 拒绝压缩中的 prompt，提前拦截保住草稿
		if (compacting) {
			showFeedback(t("composer.compacting"), "warn");
			return;
		}
		// 图片门控：草稿残留图 + 当前模型不支持（如多模态切纯文本后）→ toast 提醒不发送，保住草稿
		if (images.length > 0 && !options.imagesSupported) {
			pushToast("warning", "composer.imageUnsupported");
			return;
		}
		// 运行中保留单条排队上限；暂停或停止后的人工新消息必须能携带旧队列恢复。
		if (agentActive && followUpQueue.length >= 1 && (document || !content.startsWith("/"))) {
			showFeedback(t("composer.queueFull"), "warn");
			return;
		}
		// 同步锁：`sending` 下一帧才生效，挡不住「draft 页要先 await 转正」这个窗口里的第二次触发
		// （两次 Enter 会共享同一次 createSession，然后各自 prompt 一遍 = 同一句话发两次）
		if (!sendGuard.current.tryAcquire()) return;
		try {
			const generation = useSessionsStore.getState().newSessionDraft?.generation;
			const draft = takeDraft(options.draftKey);
			await sendNow({ content, document, draft, generation, wasActive: agentActive });
		} finally {
			sendGuard.current.release();
		}
	};

	const restoreQueue = async (sessionId: string) => {
		const cleared = await getExecutionApi(sessionId).clearQueue({ sessionId });
		const inputs =
			cleared.followUpInputs ??
			cleared.followUp.map((text) => ({ document: composerDocumentFromText(text), images: [] }));
		useDraftStore.getState().updateDraft(sessionId, (d) => inputs.reduce(appendDraftInput, d));
	};
	/** 清队列成功后才回填，保留新编辑；所有异步结果都绑定原目标。 */
	const handleStop = async () => {
		const sessionId = options.activeSessionId;
		if (!sessionId) return;
		try {
			await restoreQueue(sessionId);
			await getExecutionApi(sessionId).abort({ sessionId });
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error), sessionId);
		}
	};
	const handleRestoreQueue = async (focus: () => void) => {
		const sessionId = options.activeSessionId;
		if (!sessionId) return;
		try {
			await restoreQueue(sessionId);
			requestAnimationFrame(() => {
				if (useSessionsStore.getState().activeSessionId === sessionId) focus();
			});
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error), sessionId);
		}
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
