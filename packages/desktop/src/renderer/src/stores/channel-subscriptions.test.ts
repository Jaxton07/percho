import type { ChannelSubscriptionsSnapshot } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：channel-subscriptions store 经 getPi() 访问 */
const piMock = vi.hoisted(() => ({
	onChannelSubscriptionsChanged: vi.fn(),
	getChannelSubscriptions: vi.fn(),
}));
vi.mock("../api", () => ({ getPi: () => piMock }));

import {
	EMPTY_TOPICS,
	initChannelSubscriptions,
	invalidateChannelSubscriptionQueries,
	syncActiveSession,
	useChannelSubscriptionsStore,
} from "./channel-subscriptions";

/**
 * 频道订阅快照的 renderer 读模型（spec D1）：
 * 事件与查询两条路径互相乱序是常态，靠 `(generation, revision)` 字典序守卫统一裁决；
 * 另有生命周期守卫（切会话 / 会话被关）拒绝在途查询结果。
 */

type Listener = (snapshot: ChannelSubscriptionsSnapshot) => void;
let listeners: Listener[] = [];

/** `live` 默认 true（存活期内的乱序用例）；dispose/关闭类用例显式传 false */
const snapshot = (
	sessionId: string,
	topics: string[],
	revision: number,
	generation: number,
	live = true,
): ChannelSubscriptionsSnapshot => ({ sessionId, live, topics, revision, generation });

/** 模拟后端派发事件 */
const emit = (payload: ChannelSubscriptionsSnapshot) => {
	for (const listener of listeners) listener(payload);
};

const topicsOf = (sessionId: string) => useChannelSubscriptionsStore.getState().bySession[sessionId]?.topics;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	listeners = [];
	piMock.onChannelSubscriptionsChanged.mockImplementation((listener: Listener) => {
		listeners.push(listener);
		return () => {
			listeners = listeners.filter((item) => item !== listener);
		};
	});
	// 三张表都清（生命周期水位与 forget 计数都在 store 里 ⇒ 不会靠残留水位意外过关）
	useChannelSubscriptionsStore.setState({ bySession: {}, lifecycles: {}, forgetTokens: {} });
});

describe("apply 的新旧守卫", () => {
	it("同代：revision 更大的快照覆盖，更小的被丢弃", () => {
		const apply = useChannelSubscriptionsStore.getState().apply;
		expect(apply(snapshot("s1", ["alpha"], 5, 1))).toBe(true);
		expect(topicsOf("s1")).toEqual(["alpha"]);

		expect(apply(snapshot("s1", ["beta"], 7, 1))).toBe(true);
		expect(topicsOf("s1")).toEqual(["beta"]);

		// 晚到的旧查询（revision 更小）不得覆盖
		expect(apply(snapshot("s1", ["alpha"], 6, 1))).toBe(false);
		expect(topicsOf("s1")).toEqual(["beta"]);
	});

	it("跨代：旧代即使 revision 更大也被丢弃；新代即使 revision 更小也接受", () => {
		const apply = useChannelSubscriptionsStore.getState().apply;
		expect(apply(snapshot("s1", ["alpha"], 20, 2))).toBe(true);
		expect(apply(snapshot("s1", ["stale"], 99, 1))).toBe(false); // 上一代的迟到响应
		expect(topicsOf("s1")).toEqual(["alpha"]);
		expect(apply(snapshot("s1", ["fresh"], 1, 3))).toBe(true); // 新代（revision 计数器可以更小）
		expect(topicsOf("s1")).toEqual(["fresh"]);
	});

	it("相同钥匙（重复事件）不写：返回 false 且 topics 数组引用不变", () => {
		const apply = useChannelSubscriptionsStore.getState().apply;
		apply(snapshot("s1", ["alpha"], 5, 1));
		const before = topicsOf("s1");
		expect(apply(snapshot("s1", ["alpha"], 5, 1))).toBe(false);
		expect(topicsOf("s1")).toBe(before);
	});

	it("订阅内容没变的更新只换钥匙、沿用旧数组引用（胶囊 selector 不会被无谓唤醒）", () => {
		const apply = useChannelSubscriptionsStore.getState().apply;
		apply(snapshot("s1", ["alpha"], 5, 1));
		const before = topicsOf("s1");
		expect(apply(snapshot("s1", ["alpha"], 9, 1))).toBe(true);
		expect(topicsOf("s1")).toBe(before);
		expect(useChannelSubscriptionsStore.getState().bySession.s1?.revision).toBe(9);
	});

	it("空集是合法状态（退订后必须清掉胶囊）", () => {
		const apply = useChannelSubscriptionsStore.getState().apply;
		apply(snapshot("s1", ["alpha"], 5, 1));
		apply(snapshot("s1", [], 6, 1));
		expect(topicsOf("s1")).toEqual([]);
	});

	it("没有快照的会话返回稳定常量 EMPTY_TOPICS", () => {
		expect(useChannelSubscriptionsStore.getState().bySession.unknown).toBeUndefined();
		expect(EMPTY_TOPICS).toHaveLength(0);
	});
});

describe("事件路径（先订阅再取快照）", () => {
	it("init 之后的 events 会落到 store；cleanup 之后不再接收", () => {
		const dispose = initChannelSubscriptions();
		emit(snapshot("s1", ["alpha"], 1, 1));
		expect(topicsOf("s1")).toEqual(["alpha"]);
		dispose();
		emit(snapshot("s1", ["beta"], 2, 1));
		expect(topicsOf("s1")).toEqual(["alpha"]);
	});

	it("事件可能早于 renderer 知道这个会话：照样按 sessionId 记账", () => {
		initChannelSubscriptions();
		emit(snapshot("还没打开的会话", ["alpha"], 1, 1));
		expect(topicsOf("还没打开的会话")).toEqual(["alpha"]);
	});
});

describe("查询路径（启动 / reload 恢复）与生命周期守卫", () => {
	it("syncActiveSession 取一次快照并写入（不依赖曾收到事件）", async () => {
		piMock.getChannelSubscriptions.mockResolvedValue(snapshot("s1", ["alpha"], 3, 1));
		await syncActiveSession("s1");
		expect(piMock.getChannelSubscriptions).toHaveBeenCalledWith({ sessionId: "s1" });
		expect(topicsOf("s1")).toEqual(["alpha"]);
	});

	it("查询晚于事件回来：事件的新状态胜出", async () => {
		initChannelSubscriptions();
		const gate = deferred<ChannelSubscriptionsSnapshot>();
		piMock.getChannelSubscriptions.mockReturnValue(gate.promise);

		const pending = syncActiveSession("s1");
		emit(snapshot("s1", ["from-event"], 9, 1)); // 查询在途时来了一条更新的事件
		gate.resolve(snapshot("s1", ["from-query"], 4, 1)); // 查询结果更旧
		await pending;

		expect(topicsOf("s1")).toEqual(["from-event"]);
	});

	it("切了会话：旧查询结果丢弃（不落到新会话，也不回灌旧会话）", async () => {
		const first = deferred<ChannelSubscriptionsSnapshot>();
		const second = deferred<ChannelSubscriptionsSnapshot>();
		piMock.getChannelSubscriptions.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		const pendingA = syncActiveSession("s1");
		const pendingB = syncActiveSession("s2");
		first.resolve(snapshot("s1", ["alpha"], 5, 1)); // s1 的响应晚到
		await pendingA;
		expect(topicsOf("s1")).toBeUndefined();
		second.resolve(snapshot("s2", ["beta"], 6, 1));
		await pendingB;
		expect(topicsOf("s2")).toEqual(["beta"]);
	});

	it("会话被关（forget）后在途查询结果丢弃；forget 同时清掉已存快照", async () => {
		const gate = deferred<ChannelSubscriptionsSnapshot>();
		piMock.getChannelSubscriptions.mockReturnValue(gate.promise);
		initChannelSubscriptions();
		emit(snapshot("s1", ["alpha"], 5, 1));

		const pending = syncActiveSession("s1");
		useChannelSubscriptionsStore.getState().forget("s1"); // 关闭：后端会发空集，但先让在途查询作废
		expect(topicsOf("s1")).toBeUndefined();
		gate.resolve(snapshot("s1", ["alpha"], 5, 1));
		await pending;
		expect(topicsOf("s1")).toBeUndefined();
	});

	it("关闭后重开（新代事件）能重新显示：forget 不会永久屏蔽该会话", () => {
		initChannelSubscriptions();
		emit(snapshot("s1", ["alpha"], 5, 1));
		useChannelSubscriptionsStore.getState().forget("s1");
		expect(topicsOf("s1")).toBeUndefined();
		emit(snapshot("s1", ["alpha"], 6, 2)); // 重开后的新一代
		expect(topicsOf("s1")).toEqual(["alpha"]);
	});

	it("查询失败只记日志，不抛给调用方", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		piMock.getChannelSubscriptions.mockRejectedValue(new Error("boom"));
		await expect(syncActiveSession("s1")).resolves.toBeUndefined();
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it("activeSessionId 为 null 时不查询", async () => {
		await syncActiveSession(null);
		expect(piMock.getChannelSubscriptions).not.toHaveBeenCalled();
	});
});

describe("R7：关闭后旧事件不得复活（可见状态与生命周期水位分离）", () => {
	it("dispose 空集 → forget → 迟到的同代旧 topic 事件：不复活", () => {
		const { apply, forget } = useChannelSubscriptionsStore.getState();
		apply(snapshot("s1", ["alpha"], 5, 1)); // 订阅
		apply(snapshot("s1", [], 6, 1)); // dispose 空集：胶囊清掉
		forget("s1");
		expect(topicsOf("s1")).toBeUndefined();

		apply(snapshot("s1", ["alpha"], 5, 1)); // 关闭前那条 alpha 迟到
		expect(topicsOf("s1")).toBeUndefined(); // 旧行为会在这里复活
	});

	it("关闭时没有可见快照：迟到 dispose（live=false）抬水位，之后同代的旧 topic 一律忽略", () => {
		const { apply, forget } = useChannelSubscriptionsStore.getState();
		forget("s1"); // 从没收到过这个会话的快照
		expect(apply(snapshot("s1", [], 9, 5, false))).toBe(false); // dispose 空集迟到：只抬水位
		expect(topicsOf("s1")).toBeUndefined();
		expect(apply(snapshot("s1", ["alpha"], 8, 5, false))).toBe(false); // 同一代的旧 topic
		expect(topicsOf("s1")).toBeUndefined();
		expect(apply(snapshot("s1", ["alpha"], 7, 5))).toBe(false); // 同一代、当时还 live 的旧事件
		expect(topicsOf("s1")).toBeUndefined();
	});

	it("关闭时没有可见快照 + 真的重开（新代 live）：接受订阅", () => {
		const { apply, forget } = useChannelSubscriptionsStore.getState();
		forget("s1");
		expect(apply(snapshot("s1", ["alpha"], 9, 4))).toBe(true); // 新代且在册
		expect(topicsOf("s1")).toEqual(["alpha"]);
	});

	it("更高代 + live=false 的迟到 dispose：保持关闭、不产生可见状态、只抬水位", () => {
		const { apply, forget } = useChannelSubscriptionsStore.getState();
		apply(snapshot("s1", ["alpha"], 5, 1));
		forget("s1");
		expect(apply(snapshot("s1", [], 7, 2, false))).toBe(false); // 新代但从没在册（dispose 信号）
		expect(topicsOf("s1")).toBeUndefined();
		expect(useChannelSubscriptionsStore.getState().lifecycles.s1).toMatchObject({
			generation: 2,
			closed: true,
		});
		// 同代的旧 topic 随后到达也不能复活
		expect(apply(snapshot("s1", ["alpha"], 8, 2, false))).toBe(false);
		expect(topicsOf("s1")).toBeUndefined();
	});

	it("新代早报（更高代 + 非空）仍被接受：不能把重开永久屏蔽", () => {
		const { apply, forget } = useChannelSubscriptionsStore.getState();
		apply(snapshot("s1", ["alpha"], 5, 1));
		forget("s1");
		expect(apply(snapshot("s1", ["beta"], 6, 2))).toBe(true);
		expect(topicsOf("s1")).toEqual(["beta"]);
		expect(useChannelSubscriptionsStore.getState().lifecycles.s1?.closed).toBe(false);
		// 恢复后旧代事件依然不能回灌
		expect(apply(snapshot("s1", ["alpha"], 99, 1))).toBe(false);
		expect(topicsOf("s1")).toEqual(["beta"]);
	});

	it("更老一代的事件在关闭态下也被忽略", () => {
		const { apply, forget } = useChannelSubscriptionsStore.getState();
		apply(snapshot("s1", ["alpha"], 5, 3));
		forget("s1");
		expect(apply(snapshot("s1", ["legacy"], 50, 2))).toBe(false);
		expect(topicsOf("s1")).toBeUndefined();
	});

	it("关闭态下的查询结果（同一代空集）也不会把可见状态建回来", async () => {
		const { apply, forget } = useChannelSubscriptionsStore.getState();
		apply(snapshot("s1", ["alpha"], 5, 1));
		forget("s1");
		piMock.getChannelSubscriptions.mockResolvedValue(snapshot("s1", [], 6, 1));
		await syncActiveSession("s1");
		expect(topicsOf("s1")).toBeUndefined();
	});

	it("forget 之后重开（新代事件 → 退订 → dispose）能正常走完一轮", () => {
		const { apply, forget } = useChannelSubscriptionsStore.getState();
		apply(snapshot("s1", ["alpha"], 5, 1));
		forget("s1");
		apply(snapshot("s1", ["alpha"], 6, 2)); // 重开后订阅
		expect(topicsOf("s1")).toEqual(["alpha"]);
		apply(snapshot("s1", [], 7, 2)); // 退订
		expect(topicsOf("s1")).toEqual([]);
		apply(snapshot("s1", [], 8, 2)); // dispose
		expect(topicsOf("s1")).toEqual([]);
	});
});

describe("R8：切到新会话页 / effect cleanup 时在途查询必须作废", () => {
	it("syncActiveSession(null) 推进序号：上一个会话在途的查询结果不再落地", async () => {
		const gate = deferred<ChannelSubscriptionsSnapshot>();
		piMock.getChannelSubscriptions.mockReturnValue(gate.promise);

		const pending = syncActiveSession("s1");
		await syncActiveSession(null); // 用户切到新会话页（还没发查询）
		gate.resolve(snapshot("s1", ["alpha"], 5, 1));
		await pending;

		expect(topicsOf("s1")).toBeUndefined();
	});

	it("invalidateChannelSubscriptionQueries()（effect cleanup）让在途查询作废", async () => {
		const gate = deferred<ChannelSubscriptionsSnapshot>();
		piMock.getChannelSubscriptions.mockReturnValue(gate.promise);

		const pending = syncActiveSession("s1");
		invalidateChannelSubscriptionQueries(); // StrictMode cleanup / 卸载
		gate.resolve(snapshot("s1", ["alpha"], 5, 1));
		await pending;

		expect(topicsOf("s1")).toBeUndefined();
	});

	it("作废只影响在途查询：之后新发的同步照常落地", async () => {
		invalidateChannelSubscriptionQueries();
		piMock.getChannelSubscriptions.mockResolvedValue(snapshot("s1", ["alpha"], 5, 1));
		await syncActiveSession("s1");
		expect(topicsOf("s1")).toEqual(["alpha"]);
	});
});

describe("R10：生命周期只认明确信号（live / 本地 forget），不拿 topics 空猜关闭", () => {
	it("正常重开：forget(旧代) → 新代空集 → 同代 subscribe ⇒ 必须显示（review 反例）", () => {
		const { apply, forget } = useChannelSubscriptionsStore.getState();
		apply(snapshot("s1", ["alpha"], 5, 1)); // 旧代有订阅
		forget("s1"); // 关闭
		expect(apply(snapshot("s1", [], 7, 2))).toBe(true); // 重开后还没订阅（新代、在册、空集）
		expect(topicsOf("s1")).toEqual([]);
		expect(apply(snapshot("s1", ["beta"], 8, 2))).toBe(true); // 同代随后 subscribe
		expect(topicsOf("s1")).toEqual(["beta"]);
	});

	it("同代退订再订阅：空集只是「暂时没订阅」，不是关闭", () => {
		const { apply } = useChannelSubscriptionsStore.getState();
		apply(snapshot("s1", ["alpha"], 5, 1));
		apply(snapshot("s1", [], 6, 1)); // 退订
		expect(topicsOf("s1")).toEqual([]);
		apply(snapshot("s1", ["beta"], 7, 1)); // 再订阅（同代）
		expect(topicsOf("s1")).toEqual(["beta"]);
	});

	it("重开先空后订阅 → 退订 → 再订阅，全程不被屏蔽", () => {
		const { apply, forget } = useChannelSubscriptionsStore.getState();
		apply(snapshot("s1", ["alpha"], 5, 1));
		forget("s1");
		apply(snapshot("s1", [], 6, 2)); // 新代空
		apply(snapshot("s1", ["beta"], 7, 2));
		apply(snapshot("s1", [], 8, 2)); // 退订
		expect(topicsOf("s1")).toEqual([]);
		apply(snapshot("s1", ["gamma"], 9, 2)); // 再订阅
		expect(topicsOf("s1")).toEqual(["gamma"]);
	});

	it("旧代 / 新代乱序：旧代回灌失败，新代 dispose 生效，再新代可订阅", () => {
		const { apply } = useChannelSubscriptionsStore.getState();
		apply(snapshot("s1", ["beta"], 10, 2)); // 新代在册
		expect(apply(snapshot("s1", ["alpha"], 11, 1))).toBe(false); // 旧代晚到（revision 更大也没用）
		expect(topicsOf("s1")).toEqual(["beta"]);
		expect(apply(snapshot("s1", [], 12, 2, false))).toBe(true); // 同代 dispose（live=false）生效
		expect(topicsOf("s1")).toEqual([]);
		expect(apply(snapshot("s1", ["gamma"], 13, 3))).toBe(true); // 再开一代
		expect(topicsOf("s1")).toEqual(["gamma"]);
	});

	it("同代非空不能覆盖明确 dispose（live=false 的那条 last write 之后）", () => {
		const { apply } = useChannelSubscriptionsStore.getState();
		apply(snapshot("s1", ["beta"], 10, 2));
		apply(snapshot("s1", [], 12, 2, false)); // dispose
		expect(apply(snapshot("s1", ["beta"], 11, 2))).toBe(false); // 同代更早的订阅快照
		expect(topicsOf("s1")).toEqual([]);
	});

	it("dispose 落进可见路径后，lifecycle.closed 如实反映 live=false（review 小项）", () => {
		const { apply } = useChannelSubscriptionsStore.getState();
		apply(snapshot("s1", ["beta"], 10, 2));
		expect(useChannelSubscriptionsStore.getState().lifecycles.s1?.closed).toBe(false);
		apply(snapshot("s1", [], 12, 2, false)); // dispose（后端侧关闭，没走本地 forget）
		expect(useChannelSubscriptionsStore.getState().lifecycles.s1).toMatchObject({
			generation: 2,
			revision: 12,
			closed: true,
		});
		expect(topicsOf("s1")).toEqual([]);
		// 关闭态纪律生效：同代/更老代的快照只抬水位，不再产生可见状态
		expect(apply(snapshot("s1", ["beta"], 13, 2))).toBe(false);
		expect(apply(snapshot("s1", ["alpha"], 14, 1))).toBe(false);
		expect(topicsOf("s1")).toEqual([]);
		// 新代在册则照常恢复
		expect(apply(snapshot("s1", ["gamma"], 15, 3))).toBe(true);
		expect(topicsOf("s1")).toEqual(["gamma"]);
	});
});
