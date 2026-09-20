import { validateTopic } from "./init";

/**
 * 订阅表持久化（spec D4 / §6.3）：`pi.appendEntry()` 写入会话文件 JSONL，
 * session_start（resume/restart）时从 `ctx.sessionManager.getEntries()` 恢复。
 *
 * 形态（冒烟 V3 实证）：`{type:"custom", customType:"channel-subs", data:{topics:[...], cursors:{...}}, ...}`。
 * 每次订阅变化 append 全量最新快照（topics + 每个 topic 的内容游标）；恢复取**最后一条** channel-subs entry。
 * 旧版载荷只有 topics（无 cursors）= 「未知基线」：恢复时把当前版本记为基线，不补历史（spec §6.4）。
 * appendEntry 不进 LLM 上下文，零 token 成本。
 */

export const SUBSCRIPTION_CUSTOM_TYPE = "channel-subs";

/**
 * 持久 payload（spec §6.3）：
 * - `cursors` 整个 key 缺失 = 旧版载荷（未知基线），**不等价于某项值为 `null`**；
 * - `string` = 最后已确认的 `MESSAGES.md` 内容 hash；
 * - `null` = 确认当时文件不存在（后续文件被创建要能识别为变化）。
 */
export interface SubsPayload {
	topics: string[];
	cursors?: Record<string, string | null>;
}

/** 恢复结果：topics + 每个 topic 的 cursor（`cursors` 里没有 key = 未知基线，与值 null 不同） */
export interface RestoredSubscriptions {
	topics: string[];
	cursors: Map<string, string | null>;
}

/** topic 是否可安全拼路径（与 channel_subscribe 工具同一套校验，单一事实源） */
function isSafeTopic(topic: string): boolean {
	return typeof topic === "string" && validateTopic(topic) === null;
}

/** cursor 值是否合法（非空 string 或 null；其余脏值忽略） */
function isSafeCursor(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && value.length > 0);
}

/**
 * 构造 appendEntry 载荷（全量快照：topics 排序稳定便于测试；cursors 只留仍在订阅集的安全 topic）。
 * 没传 `cursors`（旧调用点）= 只写 topics；传了（含空 map）就写 cursors 字段。
 */
export function buildSubsPayload(
	topics: Iterable<string>,
	cursors?: ReadonlyMap<string, string | null>,
): SubsPayload {
	const safeTopics = [...new Set(topics)].filter(isSafeTopic).sort();
	if (!cursors) return { topics: safeTopics };
	const subscribed = new Set(safeTopics);
	const safeCursors: Record<string, string | null> = {};
	// 排序写入：快照内容只随真实变化变化，便于人读与 diff
	for (const topic of [...subscribed].sort()) {
		const value = cursors.get(topic);
		if (isSafeCursor(value)) safeCursors[topic] = value;
	}
	return { topics: safeTopics, cursors: safeCursors };
}

/**
 * 从会话 entries 恢复「订阅 + 游标」完整状态（spec §6.3/§6.4）：单次遍历、last-wins 整体覆盖。
 *
 * - 非法 entry（非 custom/channel-subs、data 缺失、topics 非数组）跳过且**不覆盖**此前合法快照；
 * - 非法 cursor 项（非 string/null、空串）忽略，但不影响同条目里的 topics；
 * - 只保留安全 topic（validateTopic）与其游标——游标 key 不在最终订阅集里的一律丢弃
 *   （退订不留幽灵基线）；非安全 topic 丢弃（防从会话文件注入越界路径）。
 *
 * 绝不 throw（恢复失败 = 空订阅，用户重新 subscribe 即可）。
 */
export function restoreSubscriptionState(entries: unknown): RestoredSubscriptions {
	let topics: string[] = [];
	let cursors = new Map<string, string | null>();
	try {
		if (!Array.isArray(entries)) return { topics, cursors };
		for (const entry of entries) {
			const e = entry as { type?: unknown; customType?: unknown; data?: unknown } | null | undefined;
			if (e?.type !== "custom" || e.customType !== SUBSCRIPTION_CUSTOM_TYPE) continue;
			const data = e.data as { topics?: unknown; cursors?: unknown } | null | undefined;
			const rawTopics = data?.topics;
			if (!Array.isArray(rawTopics)) continue; // 非法 entry：保留此前合法快照（不覆盖）
			// last-wins：本条目整体覆盖（含 cursors——旧载荷没有这个 key，就退化为未知基线）
			topics = [...new Set(rawTopics.filter((t): t is string => isSafeTopic(t as string)))];
			cursors = new Map();
			const rawCursors = data?.cursors;
			if (rawCursors && typeof rawCursors === "object" && !Array.isArray(rawCursors)) {
				const subscribed = new Set(topics);
				for (const [topic, value] of Object.entries(rawCursors as Record<string, unknown>)) {
					if (!subscribed.has(topic) || !isSafeCursor(value)) continue;
					cursors.set(topic, value);
				}
			}
		}
	} catch {
		// 容错：恢复失败 = 空订阅
	}
	return { topics, cursors };
}

/**
 * 兼容旧 API（只要订阅集）：与 `restoreSubscriptionState` 同一套解析（单一事实源），
 * 不再单独实现一份 last-wins 逻辑。
 */
export function restoreSubscriptions(entries: unknown): Set<string> {
	return new Set(restoreSubscriptionState(entries).topics);
}
