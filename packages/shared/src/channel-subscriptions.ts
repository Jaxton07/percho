/**
 * 频道订阅快照（spec D1）：backend 是订阅状态的唯一事实源，renderer 只读它画「频道胶囊」。
 *
 * 只带 topic 名（不带消息内容）。两把排序钥匙（renderer 按 `(generation, revision)` 字典序
 * 只接受更大的快照，越小的丢弃）：
 * - `generation`：**每 open 一代**；同一个 sessionId 被关掉重开就是新的一代（全局递增、不重复）。
 *   用来一眼判出「上一代发出的响应」—— 它可能晚于新一代到达，光靠 revision 分不清。
 *   `0` 是哨兵：该 sessionId 没有在册实例（从未打开 / 已被删除）。
 * - `revision`：backend 进程内单调时钟，每次发布 +1；同代内「后读的一定更大」。
 */
export interface ChannelSubscriptionsSnapshot {
	sessionId: string;
	/** 有效订阅的 topic 名（去重、按字典序排序的副本）；空数组 = 无有效订阅 */
	topics: string[];
	/** backend 进程内单调版本（同代内比较用） */
	revision: number;
	/** 每 open 一代（跨代比较用）；0 = 该会话没有在册实例 */
	generation: number;
}
