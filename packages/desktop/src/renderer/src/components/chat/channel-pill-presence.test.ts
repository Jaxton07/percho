import { describe, expect, it } from "vitest";
import {
	type ChannelPillPresence,
	HIDDEN_PRESENCE,
	presenceForSession,
	reduceChannelPill,
} from "./channel-pill-presence";

/**
 * 频道胶囊显示状态机（spec D2）：退场保留文本、快速开关接续、旧 timer 不得删掉新胶囊、切会话硬重置。
 * 全部是纯函数断言 —— 时序细节不藏在 effect 里，才能这么测。
 */
const SESSION = "s1";
const sync = (state: ChannelPillPresence, topics: string[]) =>
	reduceChannelPill(state, { type: "sync", sessionId: SESSION, topics });

describe("channel pill presence", () => {
	it("从空到有：展开并挂载，令牌 +1", () => {
		const state = sync(HIDDEN_PRESENCE, ["alpha"]);
		expect(state).toMatchObject({
			sessionId: SESSION,
			display: ["alpha"],
			opened: true,
			mounted: true,
			token: 1,
		});
	});

	it("新增/替换频道名：display 跟着换，仍是展开态", () => {
		const state = sync(sync(HIDDEN_PRESENCE, ["alpha"]), ["alpha", "beta"]);
		expect(state).toMatchObject({ display: ["alpha", "beta"], opened: true, mounted: true, token: 2 });
	});

	it("退订到空：开始收起，但**保留退场文本**直到收到 exitFinished", () => {
		const shown = sync(HIDDEN_PRESENCE, ["alpha"]);
		const leaving = sync(shown, []);
		expect(leaving).toMatchObject({ display: ["alpha"], opened: false, mounted: true });
		expect(leaving.token).toBe(shown.token + 1); // 令牌推进 ⇒ 旧 timer 作废

		const done = reduceChannelPill(leaving, { type: "exitFinished", token: leaving.token });
		expect(done).toMatchObject({ display: [], opened: false, mounted: false });
	});

	it("旧 timer 的 exitFinished 不能删掉新胶囊", () => {
		const shown = sync(HIDDEN_PRESENCE, ["alpha"]);
		const leaving = sync(shown, []);
		const reentered = sync(leaving, ["beta"]); // 收起途中又订阅回来
		expect(reentered).toMatchObject({ display: ["beta"], opened: true, mounted: true });

		// 还在跑的那次收起定时器（令牌是 leaving 的）
		const stale = reduceChannelPill(reentered, { type: "exitFinished", token: leaving.token });
		expect(stale).toEqual(reentered); // 原样不动
	});

	it("收起途中重复收到空集不重置定时器（否则永远收不完）", () => {
		const leaving = sync(sync(HIDDEN_PRESENCE, ["alpha"]), []);
		expect(sync(leaving, [])).toEqual(leaving);
	});

	it("本来就是空的时候收到空集：状态不变（避免无谓令牌推进）", () => {
		expect(sync(HIDDEN_PRESENCE, [])).toEqual(HIDDEN_PRESENCE);
	});

	it("切会话：硬重置 —— 旧名字清掉、DOM 立刻卸载、令牌推进让在途定时器作废", () => {
		const leaving = sync(sync(HIDDEN_PRESENCE, ["alpha"]), []);
		const reset = reduceChannelPill(leaving, { type: "reset", sessionId: "s2" });
		expect(reset).toMatchObject({ sessionId: "s2", display: [], opened: false, mounted: false });
		expect(reset.token).toBe(leaving.token + 1);
		// 旧会话的收起定时器随之失效
		expect(reduceChannelPill(reset, { type: "exitFinished", token: leaving.token })).toEqual(reset);
	});

	it("exitFinished 幂等（重复到达无副作用）", () => {
		const hidden = sync(HIDDEN_PRESENCE, []);
		expect(reduceChannelPill(hidden, { type: "exitFinished", token: hidden.token })).toEqual(hidden);
	});
});

describe("presenceForSession（渲染层按会话过滤）", () => {
	it("会话不匹配时立刻按隐藏渲染（切会话那一帧就不画旧内容）", () => {
		const shown = sync(HIDDEN_PRESENCE, ["alpha"]);
		expect(presenceForSession(shown, SESSION)).toBe(shown);
		expect(presenceForSession(shown, "s-other")).toEqual(HIDDEN_PRESENCE);
	});

	it("会话匹配（含 null 对 null）时原样返回", () => {
		expect(presenceForSession(HIDDEN_PRESENCE, null)).toBe(HIDDEN_PRESENCE);
	});
});
