import type { ImageInput } from "../session";
import { newMessageId } from "./helpers";
import type { SessionTranscriptState, UIMessage } from "./types";

/**
 * 乐观用户消息：发送瞬间本地插一条同样的气泡，权威 `message_start(user)` 到达时**原位认领**
 * （认领在 reducer 的 message_start 分支：末尾若是 pending 用户消息就替换而非追加）。
 *
 * 为什么需要它：带图发送时 SDK 会在**构造用户消息之前**对附件做归一化缩放
 * （Photon WASM，全屏截图 ~0.8–1.1s/张，见 PITFALLS「附件图片延迟」），而渲染端 `sendNow`
 * 一进来就清空了输入框的图片托盘 —— 那段时间对话区里什么都没有，观感就是「明明发出去了却半天不出现」。
 *
 * 只在**空闲发送**时插入：运行中发送走 SDK 队列，QueueBar 已经在显示排队行，再插气泡会重复。
 * 纯 UI 态：不入历史、不入 trace、不写盘；会话切换会因 loadHistory 整体替换而自然消失。
 */
export function appendOptimisticUserMessage(
	state: SessionTranscriptState,
	input: { text: string; images: ImageInput[] },
): { state: SessionTranscriptState; id: string } {
	const id = newMessageId();
	const message: UIMessage = {
		kind: "user",
		id,
		text: input.text,
		images: input.images,
		timestamp: Date.now(),
		pending: true,
	};
	return { state: { ...state, messages: [...state.messages, message] }, id };
}

/** 撤回乐观气泡（prompt 调用抛错时用；认领过的（已清 pending）不会被删） */
export function removeOptimisticUserMessage(
	state: SessionTranscriptState,
	id: string,
): SessionTranscriptState {
	const index = state.messages.findIndex((m) => m.id === id && m.kind === "user" && m.pending === true);
	if (index === -1) return state;
	return { ...state, messages: [...state.messages.slice(0, index), ...state.messages.slice(index + 1)] };
}
