/**
 * 订阅表持久化（spec D4）：`pi.appendEntry()` 写入会话文件 JSONL，
 * session_start（resume/restart）时从 `ctx.sessionManager.getEntries()` 恢复。
 *
 * 形态（冒烟 V3 实证）：`{type:"custom", customType:"channel-subs", data:{topics:[...]}, ...}`。
 * 每次订阅变化 append 全量最新集合；恢复取**最后一条** channel-subs entry。
 * appendEntry 不进 LLM 上下文，零 token 成本。
 */

export const SUBSCRIPTION_CUSTOM_TYPE = "channel-subs";

export interface SubsPayload {
	topics: string[];
}

/** 构造 appendEntry 载荷（全量快照，排序稳定便于测试） */
export function buildSubsPayload(topics: Iterable<string>): SubsPayload {
	return { topics: [...topics].sort() };
}

/**
 * 从会话 entries 恢复订阅集。entries 为 SDK SessionEntry 数组（含 message/custom 等），
 * 取**最后一条** customType 匹配的 data.topics（last-wins：退订后 append 过空集合，
 * 恢复必须得到空集，否则退订的频道会在 resume 后幽灵复活）。非法形态容错（跳过），绝不 throw。
 */
export function restoreSubscriptions(entries: unknown): Set<string> {
	let result: string[] = [];
	try {
		if (!Array.isArray(entries)) return new Set(result);
		for (const entry of entries) {
			const e = entry as {
				type?: string;
				customType?: string;
				data?: { topics?: unknown };
			};
			if (e?.type !== "custom" || e?.customType !== SUBSCRIPTION_CUSTOM_TYPE) continue;
			const topics = e?.data?.topics;
			if (!Array.isArray(topics)) continue;
			// last-wins：每条匹配 entry 整体覆盖（非法项跳过，不中断后续 entry）
			result = topics.filter((t): t is string => typeof t === "string" && t.length > 0);
		}
	} catch {
		// 容错：恢复失败 = 空订阅（用户重新 subscribe 即可）
	}
	return new Set(result);
}
