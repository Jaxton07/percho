import { buildLlmUiError, isUserAbortError, type UiError } from "../errors";

/** assistant 轮消息的最小结构（live 事件 message / replay 历史 SessionMessage 同构子集） */
interface AssistantRoundLike {
	role?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
}

/**
 * LLM 错误轮判定（决策 D1，live/replay 共用唯一实现）：
 * assistant + stopReason=error + 非空 errorMessage，且排除用户主动中断的取消错误
 * （SDK 标 error，但语义是中断不是失败）——满足才进入「挂起 pending、后续轮判定落卡」流程。
 */
export function isLlmErrorRound(m: AssistantRoundLike): m is {
	role: "assistant";
	stopReason: "error";
	errorMessage: string;
} {
	return (
		m?.role === "assistant" &&
		m.stopReason === "error" &&
		typeof m.errorMessage === "string" &&
		m.errorMessage.length > 0 &&
		!isUserAbortError(m.errorMessage)
	);
}

/** 构造 LLM 错误卡（live 用当前时刻，replay 用消息时间戳） */
export function buildRoundErrorCard(m: { errorMessage: string }, timestamp?: number): UiError {
	return buildLlmUiError(m.errorMessage, timestamp);
}
