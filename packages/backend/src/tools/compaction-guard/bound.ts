/**
 * 摘要输入有界化（spec D3）。
 *
 * **阶段 1 占位实现**：原样返回 + 只统计体积。层 1（保护区外降级：thinking / toolCall 参数 / toolResult 文本）
 * 与层 2（硬上限：整体估算 ≤ cap，从最旧整条丢）在**阶段 2** 落地。
 *
 * 纪律：
 * - 零 SDK / 零仓库 import：序列化器（SDK `serializeConversation ∘ convertToLlm`）由调用方**注入**，
 *   离线重放脚本因此能 import 同一份实现（单一事实源，绝不与脚本各写一份）。
 * - 结果必须是**新数组 + 新消息对象**，绝不就地修改入参（SDK 的 `preparation.messagesToSummarize`
 *   与默认摘要路径共享引用，见 spec §2）。
 */

import { estimateTokens } from "./estimate";
import type { CompactionBoundResult, CompactionBoundStats, GuardMessage } from "./types";

export interface BoundOptions {
	/** 生效上限（token）。`<= 0` / 非有限值 = 不介入（spec D3：cap ≤ 0 时原样交回 SDK） */
	cap: number;
	/** 保护区：最近 N 个用户轮不降级 */
	protectTurns: number;
	/** 降级后单条 tool result 文本上限（字符） */
	toolResultChars: number;
	/** 序列化器（SDK 同源，注入以保持本模块零 SDK import） */
	serialize: (messages: GuardMessage[]) => string;
}

/** 层 2 是否介入 */
export function capActive(cap: number): boolean {
	return Number.isFinite(cap) && cap > 0;
}

export function boundMessages(messages: GuardMessage[], options: BoundOptions): CompactionBoundResult {
	const estimatedBefore = estimateTokens(options.serialize(messages));
	// 阶段 1 占位：不改任何消息（阶段 2 接层 1 降级 + 层 2 硬上限）
	const stats: CompactionBoundStats = {
		messageCount: messages.length,
		degradedMessages: 0,
		droppedMessages: 0,
		estimatedBefore,
		estimatedAfter: estimatedBefore,
		cap: options.cap,
		withinCap: !capActive(options.cap) || estimatedBefore <= options.cap,
		oversizedMessages: 0,
	};
	return { messages, stats };
}
