import type { ChannelSubscriptionsSnapshot } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";

/**
 * 频道订阅快照（spec D1）· renderer 侧唯一读模型。
 *
 * 数据来源两条，**互相乱序是正常的**，统一由一把钥匙守卫：
 * - 事件（`channel:subscriptionsChanged`，携带完整快照）—— 可能在 renderer 知道这个会话之前就到（构造期上报），
 *   所以按 sessionId 记账，不做「认不认识这个会话」的过滤；
 * - 查询（`session:getChannelSubscriptions`）—— renderer 启动/reload 恢复用，**不依赖曾收到事件**。
 *
 * 守卫钥匙 = `(generation, revision)` 字典序：
 * - 跨代（generation 不同）先比代次：上一代发出的响应可能比新一代的首次快照更早、revision 更小，
 *   一旦新一代已应用就永远打不过它；反过来旧代也不会因为 revision 更大而回灌。
 * - 同代比 revision：进程内单调时钟，后读的一定更大 ⇒ 晚到的旧查询结果被丢弃。
 */
export interface AppliedChannelSubscriptions {
	/** 有效订阅（去重、字典序排序；空数组 = 无订阅） */
	topics: readonly string[];
	revision: number;
	generation: number;
}

/** 稳定模块级常量：无订阅时 selector 返回同一个引用（避免无谓重渲染），与 TodoPanel 的 EMPTY_TODOS 同一手法 */
export const EMPTY_TOPICS: readonly string[] = Object.freeze([]);

interface ChannelSubscriptionsState {
	bySession: Record<string, AppliedChannelSubscriptions>;
	/** 写入守卫；返回是否真的写入（相同钥匙或更旧的快照一律丢弃） */
	apply: (snapshot: ChannelSubscriptionsSnapshot) => boolean;
	/** 关闭/删除会话时丢掉快照，并让该会话在途的查询结果作废 */
	forget: (sessionId: string) => void;
}

/** 字典序比较：先代次、后版本 */
function isFresher(
	current: AppliedChannelSubscriptions | undefined,
	next: ChannelSubscriptionsSnapshot,
): boolean {
	if (!current) return true;
	if (next.generation !== current.generation) return next.generation > current.generation;
	return next.revision > current.revision;
}

/** sessionId → 「关闭代次」：`forget` 时自增，在途查询据此判废 */
const forgetTokens = new Map<string, number>();
let loadSeq = 0;

export const useChannelSubscriptionsStore = create<ChannelSubscriptionsState>((set) => ({
	bySession: {},

	apply: (snapshot) => {
		let wrote = false;
		set((state) => {
			const current = state.bySession[snapshot.sessionId];
			if (!isFresher(current, snapshot)) return state;
			wrote = true;
			const sameTopics =
				current !== undefined &&
				current.topics.length === snapshot.topics.length &&
				current.topics.every((topic, index) => topic === snapshot.topics[index]);
			return {
				bySession: {
					...state.bySession,
					[snapshot.sessionId]: {
						// 订阅没变就沿用旧数组引用：胶囊的 selector 因此不会被无谓地唤醒
						topics: sameTopics && current ? current.topics : snapshot.topics,
						revision: snapshot.revision,
						generation: snapshot.generation,
					},
				},
			};
		});
		return wrote;
	},

	forget: (sessionId) => {
		// 世代自增：让该会话在途的查询结果作废（关了又开时，旧响应不能落到新生命周期上）
		forgetTokens.set(sessionId, (forgetTokens.get(sessionId) ?? 0) + 1);
		set((state) => {
			if (!state.bySession[sessionId]) return state;
			const bySession = { ...state.bySession };
			delete bySession[sessionId];
			return { bySession };
		});
	},
}));

/** 当前会话的订阅（无订阅时返回稳定的 `EMPTY_TOPICS`） */
export function useChannelTopics(sessionId: string | null): readonly string[] {
	return useChannelSubscriptionsStore((s) =>
		sessionId ? (s.bySession[sessionId]?.topics ?? EMPTY_TOPICS) : EMPTY_TOPICS,
	);
}

/**
 * 先建立事件订阅，再按活动会话取一次快照（spec D1 的顺序要求）。
 * 调用方（App）必须让本函数在 `syncActiveSession` 之前跑：同一个 App 里按声明顺序各挂一个 effect 即可。
 * 返回取消订阅函数（React effect cleanup 直接 return 它）。
 */
export function initChannelSubscriptions(): () => void {
	return getPi().onChannelSubscriptionsChanged((snapshot) => {
		useChannelSubscriptionsStore.getState().apply(snapshot);
	});
}

/**
 * 取该会话的订阅快照（renderer 启动 / reload 恢复 / 切会话都走它）。
 * 生命周期守卫：期间又切了会话（`loadSeq` 变了）或该会话被关过（`forget` 代次变了）⇒ 丢弃结果。
 * 快照自身的新旧仍由 `apply` 的 (generation, revision) 守卫裁决 —— 两层各管一段，不互相替代。
 */
export async function syncActiveSession(sessionId: string | null): Promise<void> {
	if (!sessionId) return;
	const token = ++loadSeq;
	const forgetToken = forgetTokens.get(sessionId) ?? 0;
	let snapshot: ChannelSubscriptionsSnapshot;
	try {
		snapshot = await getPi().getChannelSubscriptions({ sessionId });
	} catch (error) {
		// 查询失败不抛给调用方（没有订阅胶囊只是少一个只读展示，不该影响会话打开）
		console.error("[channel-subscriptions] 订阅快照查询失败", error);
		return;
	}
	if (token !== loadSeq) return; // 用户已经切走了
	if ((forgetTokens.get(sessionId) ?? 0) !== forgetToken) return; // 期间会话被关/删过
	useChannelSubscriptionsStore.getState().apply(snapshot);
}
