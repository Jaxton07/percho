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
 * 守卫分两层，各管一段，**不能互相替代**：
 *
 * 1. **可见状态 vs 生命周期水位**（`bySession` vs `lifecycles`）。后者在 `forget` 后**保留**：
 *    关闭一代的拒旧依据不能随可见状态一起丢掉 —— 否则 dispose 空集清掉胶囊之后，一条**迟到的**
 *    旧 topic 事件（同一代、更小 revision）会因为「没有 current 可比」而把它复活（review R7 实测）。
 *    规则：
 *      · 关闭代（generation == 水位代）的任何快照都忽略；更老的一代也忽略；
 *      · 更高代 + **空集** ⇒ 只抬水位、保持关闭（新一代的生命周期信号，如 dispose / 新代还没订阅）；
 *      · 更高代 + **非空** ⇒ 接受（新代早报 / 重开后的真实订阅），解除关闭 —— 不能把重开永久屏蔽。
 * 2. **钥匙 = `(generation, revision)` 字典序**：跨代先比代次（上一代的迟到响应永远打不过新一代），
 *    同代比进程内单调 revision（后读的一定更大，晚到的旧查询结果被丢弃）。
 *
 * 生命周期水位与 `forgetTokens`/`bySession` 都放在 store 状态里（不是模块级 Map），
 * 这样测试的 `beforeEach` 能一次清干净、不会靠「残留水位」意外过关。
 */
export interface AppliedChannelSubscriptions {
	/** 有效订阅（去重、字典序排序；空数组 = 无订阅） */
	topics: readonly string[];
	revision: number;
	generation: number;
}

/** 生命周期水位：`forget` 后仍保留的判旧依据 */
interface ChannelSubscriptionLifecycle {
	generation: number;
	revision: number;
	closed: boolean;
}

/** 稳定模块级常量：无订阅时 selector 返回同一个引用（避免无谓重渲染），与 TodoPanel 的 EMPTY_TODOS 同一手法 */
export const EMPTY_TOPICS: readonly string[] = Object.freeze([]);

interface ChannelSubscriptionsState {
	/** 可见状态（只有它参与渲染） */
	bySession: Record<string, AppliedChannelSubscriptions>;
	/** 生命周期水位（关闭后仍在） */
	lifecycles: Record<string, ChannelSubscriptionLifecycle>;
	/** 查询作废计数：`forget` 时自增，在途查询据此判废 */
	forgetTokens: Record<string, number>;
	/** 写入守卫；返回是否真的写入（被忽略/更旧的快照一律丢弃） */
	apply: (snapshot: ChannelSubscriptionsSnapshot) => boolean;
	/** 关闭/删除会话：清可见状态 + 抬生命周期水位 + 让在途查询作废 */
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

/** 查询作废序号（模块级：只回答「这次同步是否还是最新意图」，与 per-session 状态无关） */
let loadSeq = 0;

export const useChannelSubscriptionsStore = create<ChannelSubscriptionsState>((set) => ({
	bySession: {},
	lifecycles: {},
	forgetTokens: {},

	apply: (snapshot) => {
		const sessionId = snapshot.sessionId;
		let wrote = false;
		set((state) => {
			const lifecycle = state.lifecycles[sessionId];
			if (lifecycle?.closed) {
				// 关闭代（含它自己的 dispose 空集与迟到的旧 topic）：一律忽略，不复活
				if (snapshot.generation <= lifecycle.generation) return state;
				if (snapshot.topics.length === 0) {
					// 新一代的空集 = 生命周期信号：只抬水位，保持关闭（不产生可见状态）
					return {
						lifecycles: {
							...state.lifecycles,
							[sessionId]: {
								generation: snapshot.generation,
								revision: snapshot.revision,
								closed: true,
							},
						},
					};
				}
				// 更高代 + 有订阅 ⇒ 新代早报 / 重开后的真实订阅：落到下面正常写入并解除关闭
			}
			const current = state.bySession[sessionId];
			if (!isFresher(current, snapshot)) return state;
			wrote = true;
			const sameTopics =
				current !== undefined &&
				current.topics.length === snapshot.topics.length &&
				current.topics.every((topic, index) => topic === snapshot.topics[index]);
			return {
				bySession: {
					...state.bySession,
					[sessionId]: {
						// 订阅没变就沿用旧数组引用：胶囊的 selector 因此不会被无谓地唤醒
						topics: sameTopics && current ? current.topics : snapshot.topics,
						revision: snapshot.revision,
						generation: snapshot.generation,
					},
				},
				lifecycles: {
					...state.lifecycles,
					[sessionId]: { generation: snapshot.generation, revision: snapshot.revision, closed: false },
				},
			};
		});
		return wrote;
	},

	forget: (sessionId) => {
		set((state) => {
			const visible = state.bySession[sessionId];
			const previous = state.lifecycles[sessionId];
			// 水位取「已见快照」与「已有水位」里更大的那份：关闭时没有可见状态也要建水位，
			// 这样「关闭事件迟到」时还能继续按关闭代忽略旧 topic。
			const generation = Math.max(visible?.generation ?? 0, previous?.generation ?? 0);
			const revision = Math.max(visible?.revision ?? -1, previous?.revision ?? -1);
			const bySession = { ...state.bySession };
			delete bySession[sessionId];
			return {
				bySession,
				lifecycles: { ...state.lifecycles, [sessionId]: { generation, revision, closed: true } },
				// 世代自增：让该会话在途的查询结果作废（关了又开时，旧响应不能落到新生命周期上）
				forgetTokens: { ...state.forgetTokens, [sessionId]: (state.forgetTokens[sessionId] ?? 0) + 1 },
			};
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
 * 让所有在途查询作废（不改变任何已落地的状态）。
 * App 里 `syncActiveSession` 那个 effect 的 cleanup 直接 return 它：卸载 / 依赖变化 / StrictMode 的
 * cleanup 之后，上一次的在途查询不会再发布结果。
 */
export function invalidateChannelSubscriptionQueries(): void {
	loadSeq += 1;
}

/**
 * 取该会话的订阅快照（renderer 启动 / reload 恢复 / 切会话都走它）。
 * 生命周期守卫：**先领号再判空** —— `syncActiveSession(null)`（切到新会话页）同样是一次新的同步意图，
 * 必须让上一个会话在途的查询作废（review R8）。
 * 快照自身的新旧仍由 `apply` 的 (generation, revision)/关闭水位裁决 —— 两层各管一段，不互相替代。
 */
export async function syncActiveSession(sessionId: string | null): Promise<void> {
	const token = ++loadSeq;
	if (!sessionId) return;
	const forgetToken = useChannelSubscriptionsStore.getState().forgetTokens[sessionId] ?? 0;
	let snapshot: ChannelSubscriptionsSnapshot;
	try {
		snapshot = await getPi().getChannelSubscriptions({ sessionId });
	} catch (error) {
		// 查询失败不抛给调用方（没有订阅胶囊只是少一个只读展示，不该影响会话打开）
		console.error("[channel-subscriptions] 订阅快照查询失败", error);
		return;
	}
	if (token !== loadSeq) return; // 用户已经切走（含切到新会话页）
	const state = useChannelSubscriptionsStore.getState();
	if ((state.forgetTokens[sessionId] ?? 0) !== forgetToken) return; // 期间会话被关/删过
	state.apply(snapshot);
}
