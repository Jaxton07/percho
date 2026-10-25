import { getExecutionApi } from "../environment-api";
import { canRetryError } from "../lib/error-retry";
import { errText } from "../lib/error-text";
import { pushToast } from "./toasts";
import { useTranscriptStore } from "./transcript";

/** 同步读取并占位，避免双击/多个卡片实例在 React 下一次渲染前重复发 IPC。 */
export async function retryFailedTurn(sessionId: string, cardId: string): Promise<void> {
	const store = useTranscriptStore.getState();
	const entry = store.bySession[sessionId];
	if (!canRetryError(entry, cardId)) return;
	const card = entry?.messages.find((message) => message.id === cardId);
	if (card?.kind !== "error" || !card.error.retryTarget) return;
	store.markAgentActive(sessionId, true);
	try {
		await getExecutionApi(sessionId).retryLastFailedTurn({ sessionId, ref: card.error.retryTarget });
	} catch (error) {
		// agent_start 会消费旧卡 target；历史重载/关闭重开会换卡片对象。
		// 用原卡身份判断，既不覆盖新 run，也不会因无关 queue/通知事件换了 entry 对象而卡住乐观 active。
		const current = useTranscriptStore.getState().bySession[sessionId];
		if (current?.messages.includes(card) && current.phase !== "streaming") {
			useTranscriptStore.getState().markAgentActive(sessionId, false);
		}
		pushToast("warning", "toast.retryFailed", errText(error));
	}
}
