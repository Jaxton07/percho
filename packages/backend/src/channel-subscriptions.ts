import type { ChannelSubscriptionsSnapshot } from "@percho/shared";
import { Emitter } from "./emitter";

/**
 * 频道订阅快照仓库（spec D1）：backend 是订阅状态的**唯一事实源**，renderer 只读。
 *
 * 只存 topic 名（不存消息内容）+ 两把排序钥匙：
 * - `revision`：**进程内单调时钟**，每次发布 +1。用来拒绝「同一代内乱序到达」的快照
 *   （renderer 只接受 key 更大的快照：后读的一定更大）。
 * - `generation`：**每 open 一代**（同一个 sessionId 被关掉再打开就是新的一代，全局递增不重复）。
 *   revision 保不了跨代比较：上一代发出的响应晚到时，它的 revision 可能比新一代的首次快照更小，
 *   一旦 renderer 已经应用了新一代，就会被这条比较挡住；反之若两代交错，只有代次能一眼判出新旧。
 *   `generation = 0` 是哨兵：这个 sessionId **没有在册实例**（从未打开 / 已被删除）。
 *
 * 语义边界（spec §6.1/§6.2）：
 * - 上报只存取快照，不做保护策略（保护在 `closeSession` 的 intent 守卫 + renderer 纯策略层）；
 * - 空集 = 移出快照（退订最后一个 topic 即恢复普通 GC 资格），**内容没变则不发布**（不刷事件）；
 * - `dispose` **无条件发布空集**：这是「这一代结束了」的生命周期信号，不依赖扩展 shutdown 是否上报；
 * - GC 查询（`loadedSessionIdsWithSubscriptions`）仍按「是否仍在 registry 中」过滤：回调/构造异常
 *   路径可能留下孤儿键，不能让一个已不存在的会话 ID 永久影响 GC 判定。
 */
export class ChannelSubscriptionRegistry {
	/** sessionId → 有效订阅集合（空集不落表） */
	private readonly topics = new Map<string, Set<string>>();
	/**
	 * sessionId → 在册代次。`dispose` 后**保留代次值**（标 `live: false`）——关闭状态下查询也能给出
	 * 稳定答案（同一代的旧响应因此仍被 revision 挡住）；下一次上报/打开会领新的一代。
	 */
	private readonly incarnations = new Map<string, { generation: number; live: boolean }>();
	private readonly emitter = new Emitter<ChannelSubscriptionsSnapshot>();
	private revision = 0;
	private incarnationSeq = 0;

	/**
	 * @param isLive 该 sessionId 是否仍在 registry 中（只给 GC 查询用；单会话快照**不**过滤，
	 *   因为扩展可能早于 registry.add 上报，过滤会让「刚打开就有订阅」的会话查到空集）
	 */
	constructor(private readonly isLive: (sessionId: string) => boolean) {}

	/** 订阅发布（main 转发给 renderer） */
	subscribe(handler: (snapshot: ChannelSubscriptionsSnapshot) => void): () => void {
		return this.emitter.subscribe(handler);
	}

	/** 打开/注册一代（PiBackend 在 registry.add 后调用）；早报过的会话也在这里拿到最终代次 */
	noteSessionOpened(sessionId: string): void {
		this.incarnations.set(sessionId, { generation: ++this.incarnationSeq, live: true });
	}

	/**
	 * channel-watch 扩展回调入口（spec §6.1）：上报该会话当前的「有效运行态订阅」快照。
	 * 内容与代次都没变 ⇒ 不发布（避免刷事件）；空集 ⇒ 移出快照。
	 */
	report(sessionId: string, topics: ReadonlySet<string>): void {
		const next = [...topics].sort();
		if (this.isLiveIncarnation(sessionId) && sameTopics(this.topics.get(sessionId), next)) return;
		if (next.length === 0) this.topics.delete(sessionId);
		else this.topics.set(sessionId, new Set(next));
		// 早报路径：session_start 前就上报（扩展构造期）时还没有代次，先领一代
		if (!this.incarnations.get(sessionId)?.live) {
			this.incarnations.set(sessionId, { generation: ++this.incarnationSeq, live: true });
		}
		this.publish(sessionId);
	}

	/**
	 * 会话处置（关闭/卸载/删除前）：清订阅并**无条件发布空集**，把该代标成 not-live。
	 * 正常路径扩展的 shutdown 会上报空集（一次内容变化发布），这里是兜底 + 生命周期信号，
	 * 保证 renderer 不会残留一个「其实已经关了」的订阅状态。
	 */
	dispose(sessionId: string): void {
		this.topics.delete(sessionId);
		const entry = this.incarnations.get(sessionId);
		if (entry) entry.live = false; // 保留 generation：关闭状态下的查询仍然稳定
		this.publish(sessionId);
	}

	/** 会话被删除（磁盘也没了）：连代次记录一起清，避免表无限增长 */
	delete(sessionId: string): void {
		this.topics.delete(sessionId);
		this.incarnations.delete(sessionId);
	}

	/**
	 * 单会话快照（renderer 一次性查询 / reload 恢复用）。
	 * `revision` = 读取时刻的进程时钟（不是「该会话上次变化的版本」）：renderer 按 (generation, revision)
	 * 字典序比大小，同代内「后读的更大」这条不变式照样成立。
	 */
	snapshot(sessionId: string): ChannelSubscriptionsSnapshot {
		return {
			sessionId,
			topics: [...(this.topics.get(sessionId) ?? [])].sort(),
			revision: this.revision,
			generation: this.incarnations.get(sessionId)?.generation ?? 0,
		};
	}

	/**
	 * renderer GC 查询用（spec §6.2）：**仍在 registry 中**且有效频道订阅非空的会话 ID
	 * （顺序不构成契约）。语义与改造前完全一致。
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
