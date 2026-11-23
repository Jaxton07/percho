import type { ChannelSubscriptionsSnapshot } from "@percho/shared";
import { Emitter } from "./emitter";

/**
 * SQLite 成员和未读状态的 UI 投影，不保存正文，也不承担持久权威或 GC 保护。
 *
 * topic/未读数使用两把排序钥匙拒绝迟到响应：
 * - `revision`：**进程内单调时钟**，每次发布 +1。用来拒绝「同一代内乱序到达」的快照
 *   （renderer 只接受 key 更大的快照：后读的一定更大）。
 * - `generation`：**每 open 一代**（同一个 sessionId 被关掉再打开就是新的一代，全局递增不重复）。
 *   revision 保不了跨代比较：上一代发出的响应晚到时，它的 revision 可能比新一代的首次快照更小，
 *   一旦 renderer 已经应用了新一代，就会被这条比较挡住；反之若两代交错，只有代次能一眼判出新旧。
 *   `generation = 0` 是哨兵：这个 sessionId **没有在册实例**（从未打开 / 已被删除）。
 *
 * 数量变化也发布；关闭只标记运行实例结束，不冒充持久退订。
 * renderer 用 live/代次判断运行生命周期，不能从 topic 是否为空推断关闭。
 */
export class ChannelSubscriptionRegistry {
	/** sessionId → 有效订阅集合（空集不落表） */
	private readonly topics = new Map<string, Set<string>>();
	private readonly counts = new Map<string, Record<string, number>>();
	/**
	 * sessionId → 在册代次。`dispose` 后**保留代次值**（标 `live: false`）——关闭状态下查询也能给出
	 * 稳定答案（同一代的旧响应因此仍被 revision 挡住）；下一次打开会领新的一代。
	 *
	 * 代次**只由 `noteSessionOpened` 产生**：早报（扩展构造期上报）不单独占一代，它的订阅先落表、
	 * 等注册确认时用那一代发布一次 —— 所以「每 open 恰好一代」是字面成立的（见 `pendingPublish`）。
	 */
	private readonly incarnations = new Map<string, { generation: number; live: boolean }>();
	/** 早报过、还没注册确认的会话：`noteSessionOpened` 时用新代次统一发布一次 */
	private readonly pendingPublish = new Set<string>();
	private readonly emitter = new Emitter<ChannelSubscriptionsSnapshot>();
	private revision = 0;
	private incarnationSeq = 0;

	/**
	 * @param isLive 该 sessionId 是否仍在 registry 中（只给兼容运行态查询用；单会话快照**不**过滤，
	 *   因为扩展可能早于 registry.add 上报，过滤会让「刚打开就有订阅」的会话查到空集）
	 */
	constructor(private readonly isLive: (sessionId: string) => boolean) {}

	/** 订阅发布（main 转发给 renderer） */
	subscribe(handler: (snapshot: ChannelSubscriptionsSnapshot) => void): () => void {
		return this.emitter.subscribe(handler);
	}

	/**
	 * 打开/注册一代（PiBackend 在 registry.add 后调用）：**代次唯一来源**。
	 * 若这个会话在构造期已上报过（早报），此刻用这一代发布一次，让 renderer 拿到「开箱即有」的状态。
	 */
	noteSessionOpened(sessionId: string): void {
		this.incarnations.set(sessionId, { generation: ++this.incarnationSeq, live: true });
		if (this.pendingPublish.delete(sessionId)) this.publish(sessionId);
	}

	/**
	 * 旧宿主的兼容入口；生产频道通过 reportEntries 上报带未读数的投影。
	 * 内容与代次都没变 ⇒ 不发布（避免刷事件）；空集 ⇒ 移出快照。
	 *
	 * **早报**（`session_start` 前、扩展构造期上报，此时还没有在册代次）：只落表 + 记待发布，
	 * 代次由随后的 `noteSessionOpened` 定并统一发布 —— 这样早报不会另占一代（查询也能查到，
	 * 因为 `snapshot()` 读的就是这张表）。
	 */
	report(sessionId: string, topics: ReadonlySet<string>): void {
		this.reportEntries(
			sessionId,
			[...topics].map((topic) => ({ topic, unread: 0 })),
		);
	}

	reportEntries(sessionId: string, entries: readonly { topic: string; unread: number }[]): void {
		const counts = Object.fromEntries(entries.map(({ topic, unread }) => [topic, unread]));
		const next = Object.keys(counts).sort();
		const previous = this.counts.get(sessionId);
		const confirmed = this.isLiveIncarnation(sessionId);
		if (
			confirmed &&
			sameTopics(this.topics.get(sessionId), next) &&
			next.every((topic) => previous?.[topic] === counts[topic])
		)
			return;
		this.counts.set(sessionId, counts);
		if (next.length === 0) this.topics.delete(sessionId);
		else this.topics.set(sessionId, new Set(next));
		if (!confirmed) {
			this.pendingPublish.add(sessionId); // 早报：等注册确认时用那一代发布
			return;
		}
		this.publish(sessionId);
	}

	/** 关闭/卸载结束运行代次并发布 live=false；保留持久成员投影供重开刷新。 */
	dispose(sessionId: string): void {
		this.pendingPublish.delete(sessionId);
		const entry = this.incarnations.get(sessionId);
		if (entry) entry.live = false; // 保留 generation：关闭状态下的查询仍然稳定
		this.publish(sessionId);
	}

	/** 会话被删除（磁盘也没了）：连代次记录一起清，避免表无限增长 */
	delete(sessionId: string): void {
		this.topics.delete(sessionId);
		this.counts.delete(sessionId);
		this.incarnations.delete(sessionId);
		this.pendingPublish.delete(sessionId);
	}

	/**
	 * 单会话快照（renderer 一次性查询 / reload 恢复用）。
	 * `revision` = 读取时刻的进程时钟（不是「该会话上次变化的版本」）：renderer 按 (generation, revision)
	 * 字典序比大小，同代内「后读的更大」这条不变式照样成立。
	 */
	snapshot(sessionId: string): ChannelSubscriptionsSnapshot {
		const incarnation = this.incarnations.get(sessionId);
		return {
			sessionId,
			// 在册与否是**独立字段**（不是从 topics 猜）：重开后暂时没订阅仍是 live=true，
			// dispose 保留 topics 但标 live=false；关闭水位只认生命周期信号。
			live: incarnation?.live === true,
			topics: [...(this.topics.get(sessionId) ?? [])].sort(),
			unreadCounts: { ...this.counts.get(sessionId) },
			revision: this.revision,
			generation: incarnation?.generation ?? 0,
		};
	}

	/**
	 * 兼容运行态查询，顺序不构成契约。频道订阅不再用于决定 GC 资格。
	 */
	loadedSessionIdsWithSubscriptions(): string[] {
		return [...this.topics.keys()].filter((id) => this.isLive(id));
	}

	private isLiveIncarnation(sessionId: string): boolean {
		return this.incarnations.get(sessionId)?.live === true;
	}

	private publish(sessionId: string): void {
		this.revision += 1;
		this.emitter.emit(this.snapshot(sessionId));
	}
}

/** 内容相同判断（topic 名去重后按字典序比较） */
function sameTopics(current: ReadonlySet<string> | undefined, next: readonly string[]): boolean {
	if (!current) return next.length === 0;
	if (current.size !== next.length) return false;
	return next.every((topic) => current.has(topic));
}
