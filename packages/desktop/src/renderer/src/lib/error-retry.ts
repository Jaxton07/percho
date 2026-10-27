import type { SessionTranscriptState } from "@percho/shared";

/** 只允许末端、仍有失败响应定位的卡片重试；系统通知/压缩分割线不算新任务。 */
export function canRetryError(entry: SessionTranscriptState | undefined, cardId: string): boolean {
	if (
		!entry ||
		entry.agentActive ||
		entry.phase !== "idle" ||
		entry.streaming ||
		entry.compacting ||
		entry.compactionPause ||
		entry.retrying ||
		entry.followUpQueue.length > 0
	)
		return false;
	const index = entry.messages.findLastIndex((message) => message.id === cardId);
	const card = entry.messages[index];
	return (
		card?.kind === "error" &&
		card.error.actions.includes("retry") &&
		card.error.retryTarget !== undefined &&
		entry.messages.slice(index + 1).every((message) => message.kind === "system")
	);
}
