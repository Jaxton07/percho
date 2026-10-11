import { describe, expect, it } from "vitest";
import {
	applyOutcome,
	backoffMultiplier,
	cooldownMsFor,
	createGuardState,
	decideTrigger,
	failedBackoffMultiplier,
	judgeOutcome,
	MAX_FAILED_MULTIPLIER,
	MAX_INEFFECTIVE_STREAK,
	percentOf,
	recordTrigger,
} from "../src/tools/compaction-guard/guard";
import { DEFAULT_COMPACTION_GUARD_CONFIG } from "../src/tools/compaction-guard/types";

/**
 * 触发判定与退避（spec D1/D2/D6，验收 A2）：
 * 阈值边界 79.9/80.1、tokens=null、冷却、连续无效的递增退避。
 */

const config = DEFAULT_COMPACTION_GUARD_CONFIG;
const WINDOW = 1_000_000;
const NOW = 1_700_000_000_000;

const usage = (tokens: number | null, contextWindow = WINDOW) => ({ tokens, contextWindow });

describe("percentOf", () => {
	it("tokens=null 或窗口非法 → null", () => {
		expect(percentOf(null, WINDOW)).toBeNull();
		expect(percentOf(100, 0)).toBeNull();
		expect(percentOf(100, Number.NaN)).toBeNull();
	});

	it("正常换算", () => {
		expect(percentOf(800_000, WINDOW)).toBe(80);
		expect(percentOf(991_721, WINDOW)).toBeCloseTo(99.1721, 4);
	});
});

describe("decideTrigger（阈值边界）", () => {
	it("79.9% → 不触发（below-threshold）", () => {
		const decision = decideTrigger({ config, usage: usage(799_000), state: createGuardState(), now: NOW });
		expect(decision.trigger).toBe(false);
		expect(decision).toMatchObject({ reason: "below-threshold" });
		expect(decision.percent).toBeCloseTo(79.9, 6);
	});

	it("80% 与 80.1% → 触发（阈值含等号：percent ≥ thresholdPct）", () => {
		for (const tokens of [800_000, 801_000]) {
			const decision = decideTrigger({ config, usage: usage(tokens), state: createGuardState(), now: NOW });
			expect(decision.trigger).toBe(true);
			if (decision.trigger) {
				expect(decision.tokens).toBe(tokens);
				expect(decision.contextWindow).toBe(WINDOW);
				expect(decision.cooldownMs).toBe(config.cooldownMs);
			}
		}
	});

	it("阈值按配置走（thresholdPct=60 时 60.0% 触发、59.9% 不触发）", () => {
		const custom = { ...config, thresholdPct: 60 };
		expect(
			decideTrigger({ config: custom, usage: usage(599_000), state: createGuardState(), now: NOW }).trigger,
		).toBe(false);
		expect(
			decideTrigger({ config: custom, usage: usage(600_000), state: createGuardState(), now: NOW }).trigger,
		).toBe(true);
	});
});

describe("decideTrigger（跳过分支）", () => {
	it("disabled → 不触发（逃生舱）", () => {
		const decision = decideTrigger({
			config: { ...config, enabled: false },
			usage: usage(990_000),
			state: createGuardState(),
			now: NOW,
		});
		expect(decision).toMatchObject({ trigger: false, reason: "disabled" });
	});

	it("tokens=null（刚压缩完 / 会话首轮）→ no-usage；usage 缺失 → no-usage", () => {
		expect(decideTrigger({ config, usage: usage(null), state: createGuardState(), now: NOW })).toMatchObject({
			trigger: false,
			reason: "no-usage",
		});
		expect(decideTrigger({ config, usage: undefined, state: createGuardState(), now: NOW })).toMatchObject({
			trigger: false,
			reason: "no-usage",
		});
	});

	it("窗口 <= 0 → no-window", () => {
		expect(
			decideTrigger({ config, usage: usage(900_000, 0), state: createGuardState(), now: NOW }),
		).toMatchObject({
			trigger: false,
			reason: "no-window",
		});
	});

	it("冷却内不重复触发，出冷却即触发", () => {
		const state = recordTrigger(createGuardState(), NOW);
		expect(decideTrigger({ config, usage: usage(900_000), state, now: NOW + 29_999 })).toMatchObject({
			trigger: false,
			reason: "cooldown",
		});
		expect(decideTrigger({ config, usage: usage(900_000), state, now: NOW + 30_000 }).trigger).toBe(true);
	});

	it("冷却是「自上次触发」而不是「自上次压缩」：失败重试也受同一冷却约束", () => {
		const state = recordTrigger(createGuardState(), NOW);
		const justFailed = applyOutcome(state, "ineffective");
		expect(
			decideTrigger({ config, usage: usage(900_000), state: justFailed, now: NOW + 1_000 }),
		).toMatchObject({
			trigger: false,
			reason: "cooldown",
		});
	});
});

describe("退避（连续无效压缩）", () => {
	it("无效阶梯倍数 1→2→4→8（streak 封顶 3）", () => {
		expect(backoffMultiplier(0)).toBe(1);
		expect(backoffMultiplier(1)).toBe(2);
		expect(backoffMultiplier(2)).toBe(4);
		expect(backoffMultiplier(3)).toBe(8);
		expect(backoffMultiplier(99)).toBe(8); // 封顶
		expect(cooldownMsFor({ ...createGuardState(), ineffectiveStreak: 2 }, config)).toBe(
			config.cooldownMs * 4,
		);
	});

	it("失败阶梯：不封顶地递增，但倍数最多 ×8（= 4 分钟）", () => {
		expect(failedBackoffMultiplier(0)).toBe(1);
		expect(failedBackoffMultiplier(1)).toBe(2);
		expect(failedBackoffMultiplier(3)).toBe(8);
		expect(failedBackoffMultiplier(10)).toBe(MAX_FAILED_MULTIPLIER);
		expect(MAX_FAILED_MULTIPLIER).toBe(8);
		expect(cooldownMsFor({ ...createGuardState(), failedStreak: 10 }, config)).toBe(config.cooldownMs * 8);
	});

	it("冷却取两条阶梯的较大倍数（无效 2 × 失败 3 ⇒ 取 8）", () => {
		expect(cooldownMsFor({ lastTriggerAt: null, ineffectiveStreak: 2, failedStreak: 3 }, config)).toBe(
			config.cooldownMs * 8,
		);
	});

	it("无效 1 次 → 冷却翻倍（30s → 60s）", () => {
		let state = recordTrigger(createGuardState(), NOW);
		state = applyOutcome(state, "ineffective");
		expect(decideTrigger({ config, usage: usage(900_000), state, now: NOW + 45_000 })).toMatchObject({
			trigger: false,
			reason: "cooldown",
		});
		expect(decideTrigger({ config, usage: usage(900_000), state, now: NOW + 60_000 }).trigger).toBe(true);
	});

	it(`连续 ${MAX_INEFFECTIVE_STREAK} 次无效 → 不再主动触发（backoff），交给 SDK 后置路径`, () => {
		let state = createGuardState();
		for (let i = 0; i < MAX_INEFFECTIVE_STREAK; i++) {
			state = recordTrigger(state, NOW);
			state = applyOutcome(state, "ineffective");
		}
		// 早已出冷却（100 倍冷却时长之后）也不再触发
		expect(
			decideTrigger({ config, usage: usage(999_000), state, now: NOW + 100 * config.cooldownMs }),
		).toMatchObject({ trigger: false, reason: "backoff" });
	});

	it("有效压缩 → 两条阶梯都清零（下一次触发不受历史影响）", () => {
		let state = recordTrigger(createGuardState(), NOW);
		state = applyOutcome(state, "ineffective");
		state = applyOutcome(state, "failed");
		state = applyOutcome(state, "ok");
		expect(state.ineffectiveStreak).toBe(0);
		expect(state.failedStreak).toBe(0);
		const decision = decideTrigger({ config, usage: usage(900_000), state, now: NOW + config.cooldownMs });
		expect(decision.trigger).toBe(true);
		if (decision.trigger) expect(decision.cooldownMs).toBe(config.cooldownMs);
	});

	describe("两条阶梯的状态机（混合序列）", () => {
		it("失败不累计到无效阶梯：失败 5 次仍然能触发（只被拉长冷却，不封顶停手）", () => {
			let state = createGuardState();
			for (let i = 0; i < 5; i++) {
				state = recordTrigger(state, NOW);
				state = applyOutcome(state, "failed");
			}
			expect(state.ineffectiveStreak).toBe(0);
			expect(state.failedStreak).toBe(5);
			expect(
				decideTrigger({ config, usage: usage(990_000), state, now: NOW + config.cooldownMs * 8 - 1 }).trigger,
			).toBe(false); // 冷却还差 1ms
			expect(
				decideTrigger({ config, usage: usage(990_000), state, now: NOW + config.cooldownMs * 8 }).trigger,
			).toBe(
				true, // 8× 冷却走完即恢复（失败不会封顶停手）
			);
		});

		it("「无效」会清掉失败计数（那次压缩本身是成功的）", () => {
			let state = applyOutcome(createGuardState(), "failed");
			state = applyOutcome(state, "failed");
			state = applyOutcome(state, "ineffective");
			expect(state.failedStreak).toBe(0);
			expect(state.ineffectiveStreak).toBe(1);
		});

		it("混合序列：失败→无效→ok 后两条都归零；再无效 3 次才停手", () => {
			let state = createGuardState();
			state = applyOutcome(state, "failed");
			state = applyOutcome(state, "ineffective");
			expect(state).toMatchObject({ failedStreak: 0, ineffectiveStreak: 1 });
			state = applyOutcome(state, "ok");
			expect(state).toMatchObject({ failedStreak: 0, ineffectiveStreak: 0 });
			state = applyOutcome(state, "ineffective");
			state = applyOutcome(state, "ineffective");
			expect(
				decideTrigger({ config, usage: usage(990_000), state, now: NOW + config.cooldownMs * 8 }).trigger,
			).toBe(
				true, // 还没到 3 次
			);
			state = applyOutcome(state, "ineffective");
			expect(
				decideTrigger({ config, usage: usage(990_000), state, now: NOW + 100 * config.cooldownMs }),
			).toMatchObject({ trigger: false, reason: "backoff" });
		});
	});
});

describe("judgeOutcome（压缩效果判定，spec D6）", () => {
	it("仍 ≥ 阈值且下降 < 5 个百分点 → ineffective", () => {
		expect(judgeOutcome({ percentBefore: 96, percentNow: 95, thresholdPct: 80 })).toEqual({
			outcome: "ineffective",
			dropPct: 1,
		});
		expect(judgeOutcome({ percentBefore: 96, percentNow: 91.001, thresholdPct: 80 }).outcome).toBe(
			"ineffective",
		);
	});

	it("下降 ≥ 5 个百分点 → ok（哪怕仍在阈值之上）", () => {
		expect(judgeOutcome({ percentBefore: 96, percentNow: 91, thresholdPct: 80 })).toEqual({
			outcome: "ok",
			dropPct: 5,
		});
	});

	it("已压到阈值之下 → ok（哪怕只降一点）", () => {
		expect(judgeOutcome({ percentBefore: 96, percentNow: 79.9, thresholdPct: 80 }).outcome).toBe("ok");
	});

	it("上下文反而变大（下降为负）且仍 ≥ 阈值 → ineffective", () => {
		const judged = judgeOutcome({ percentBefore: 90, percentNow: 93, thresholdPct: 80 });
		expect(judged.outcome).toBe("ineffective");
		expect(judged.dropPct).toBe(-3);
	});
});
