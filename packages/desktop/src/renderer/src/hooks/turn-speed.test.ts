import {
	aggregateDecode,
	buildTurnSpeedView,
	deriveTurnSpeed,
	estimateStreamingTokens,
	type TurnSpeedSample,
} from "@percho/shared";
import { describe, expect, it } from "vitest";

const sample = (
	output: unknown,
	durationMs: unknown,
	extra: Partial<TurnSpeedSample> = {},
): TurnSpeedSample => ({ output, durationMs, ...extra });

describe("deriveTurnSpeed（api 口径：Σ output ÷ Σ durationMs）", () => {
	it("单轮聚合：speed = Σ 输出 token ÷ Σ 生成耗时", () => {
		const snapshot = deriveTurnSpeed([[sample(1510, 41212), sample(500, 20000)]]);
		expect(snapshot.current).toMatchObject({
			turnIndex: 0,
			outputTokens: 2010,
			durationMs: 61212,
			promptTokens: 0,
			samples: 2,
		});
		expect(snapshot.current?.speed).toBeCloseTo(2010 / 61.212, 6);
	});

	it("逐轮切分：每轮独立速度，turns 按 turnIndex 升序，session 为全会话累计", () => {
		const snapshot = deriveTurnSpeed([
			[sample(100, 1000)],
			[sample(50, 2000, { stopReason: "error" }), sample(400, 4000)],
			[sample(30, 60)],
		]);
		expect(snapshot.turns.map((turn) => turn.turnIndex)).toEqual([0, 1, 2]);
		expect(snapshot.turns.map((turn) => turn.outputTokens)).toEqual([100, 400, 30]);
		expect(snapshot.turns.map((turn) => turn.samples)).toEqual([1, 1, 1]);
		expect(snapshot.session.outputTokens).toBe(530);
		expect(snapshot.session.durationMs).toBe(5060);
		expect(snapshot.current?.turnIndex).toBe(2);
	});

	it("只有当前轮带 messages 明细（tooltip 与 decode 拆分用；历史轮不带，控载荷）", () => {
		const snapshot = deriveTurnSpeed([[sample(100, 1000)], [sample(200, 2000)]]);
		expect(snapshot.turns[0]?.messages).toBeUndefined();
		expect(snapshot.current?.messages).toHaveLength(1);
	});

	it("promptTokens = input + cacheRead + cacheWrite（prefill 占比的解释分量）", () => {
		const snapshot = deriveTurnSpeed([
			[
				sample(100, 1000, {
					promptTokens: 120 + 48_000 + 300,
					model: "minimax-m2",
					provider: "minimax",
				}),
			],
		]);
		expect(snapshot.current?.promptTokens).toBe(48_420);
		expect(snapshot.current?.model).toBe("minimax-m2");
	});

	it("空样本 / 缺字段 / 非法值 → 该样本丢弃；全丢弃 → current null（宁缺勿错）", () => {
		expect(deriveTurnSpeed([]).current).toBeNull();
		expect(deriveTurnSpeed([[sample(undefined, 100)]]).current).toBeNull();
		expect(deriveTurnSpeed([[sample(10, undefined)]]).current).toBeNull();
		expect(deriveTurnSpeed([[sample("10", 100)]]).current).toBeNull();
		expect(deriveTurnSpeed([[sample(Number.NaN, 100)]]).current).toBeNull();
		expect(deriveTurnSpeed([[sample(10, 0)]]).current).toBeNull();
		expect(deriveTurnSpeed([[sample(10, Number.POSITIVE_INFINITY)]]).current).toBeNull();
	});

	it("output === 0 不计数：只增分母不增分子，是纯稀释项", () => {
		const snapshot = deriveTurnSpeed([[sample(0, 3000), sample(100, 5000)]]);
		expect(snapshot.current).toMatchObject({ outputTokens: 100, durationMs: 5000, samples: 1 });
	});

	it("拒绝 >1000 tok/s 的不可信样本（output > durationMs）；有效样本仍计入", () => {
		expect(deriveTurnSpeed([[sample(1500, 1000)]]).current).toBeNull();
		const snapshot = deriveTurnSpeed([[sample(1500, 1000), sample(100, 5000)]]);
		expect(snapshot.current).toMatchObject({ outputTokens: 100, durationMs: 5000, samples: 1 });
		expect(deriveTurnSpeed([[sample(1000, 1000)]], {}).current?.speed).toBe(1000);
	});

	it("排除 stopReason=error 的失败消息（重试轮的失败尝试会稀释速度）", () => {
		const snapshot = deriveTurnSpeed([
			[sample(50, 2000, { stopReason: "error" }), sample(200, 8000, { stopReason: "stop" })],
		]);
		expect(snapshot.current).toMatchObject({ outputTokens: 200, durationMs: 8000, samples: 1 });
	});

	it("无有效样本的轮不进入 turns 列表（历史轮不显示假速度）", () => {
		const snapshot = deriveTurnSpeed([[sample(100, 1000)], [sample(0, 500)], [sample(60, 600)]]);
		expect(snapshot.turns.map((turn) => turn.turnIndex)).toEqual([0, 2]);
	});

	it("maxTurns 截断保留最近若干轮并置 truncated", () => {
		const turns = Array.from({ length: 5 }, () => [sample(100, 1000)]);
		const snapshot = deriveTurnSpeed(turns, { maxTurns: 2 });
		expect(snapshot.truncated).toBe(true);
		expect(snapshot.turns.map((turn) => turn.turnIndex)).toEqual([3, 4]);
		expect(snapshot.session.outputTokens).toBe(500); // 累计不受截断影响
	});
});

describe("aggregateDecode（decode 口径：剔除实测 prefill）", () => {
	const messages =
		deriveTurnSpeed([
			[sample(1000, 10_000, { promptTokens: 50_000 }), sample(500, 5_000, { promptTokens: 10_000 })],
		]).current?.messages ?? [];

	it("拆出 prefill/decode：speed = Σ output ÷ Σ (durationMs − prefillMs)", () => {
		const decode = aggregateDecode(messages, [2000, 1000]);
		expect(decode).toMatchObject({ outputTokens: 1500, durationMs: 12_000, prefillMs: 3_000, covered: 2 });
		expect(decode?.speed).toBeCloseTo(125, 6);
	});

	it("观测缺失/非法（null、负值=跨机时钟偏移、≥ 总时长）→ 该条不参与拆分", () => {
		expect(aggregateDecode(messages, [null, 1000])?.covered).toBe(1);
		expect(aggregateDecode(messages, [-5, 1000])?.covered).toBe(1);
		expect(aggregateDecode(messages, [10_000, 1000])?.covered).toBe(1); // prefill == duration → 无生成窗口
		expect(aggregateDecode(messages, [null, null])).toBeNull();
	});
});

describe("buildTurnSpeedView（口径选择与降级）", () => {
	const snapshot = deriveTurnSpeed([[sample(1000, 10_000, { promptTokens: 60_000, model: "m1" })]]);

	it("有 TTFT 观测 → 展示 decode 口径，并保留 api 口径可辨", () => {
		const view = buildTurnSpeedView(snapshot, [3000], null);
		expect(view?.metric).toBe("decode");
		expect(view?.speed).toBeCloseTo(1000 / 7, 6);
		expect(view?.apiSpeed).toBeCloseTo(100, 6);
		expect(view?.prefillMs).toBe(3000);
		expect(view?.model).toBe("m1");
	});

	it("无观测 → 退回 api 口径（不出假数）", () => {
		const view = buildTurnSpeedView(snapshot, [], null);
		expect(view?.metric).toBe("api");
		expect(view?.speed).toBeCloseTo(100, 6);
		expect(view?.decodeSpeed).toBeNull();
	});

	it("本轮无权威样本但有 live → 纯 live 视图（metric api，samples 0）", () => {
		const view = buildTurnSpeedView(deriveTurnSpeed([[sample(0, 500)]]), [], { tokens: 320, speed: 41.5 });
		expect(view).toMatchObject({ metric: "api", speed: 41.5, samples: 0, live: true, liveTokens: 320 });
	});

	it("快照 null → null；无样本且无 live → null（插件应隐藏）", () => {
		expect(buildTurnSpeedView(null, [], null)).toBeNull();
		expect(buildTurnSpeedView(deriveTurnSpeed([]), [], null)).toBeNull();
	});

	it("历史轮与全会话累计透传", () => {
		const many = deriveTurnSpeed([[sample(100, 1000)], [sample(200, 1000)]]);
		const view = buildTurnSpeedView(many, [], null);
		expect(view?.turns).toHaveLength(2);
		expect(view?.session.outputTokens).toBe(300);
	});
});

describe("estimateStreamingTokens（流式期间瞬时指示，非权威值）", () => {
	it("latin ≈4 字符/token，CJK ≈1 字符/token", () => {
		expect(estimateStreamingTokens(["abcd"])).toBe(1);
		expect(estimateStreamingTokens(["中文字"])).toBe(3);
		expect(estimateStreamingTokens(["中文", "abcd"])).toBe(3); // 2 CJK + 4 latin(≈1)
		expect(estimateStreamingTokens(["", ""])).toBe(0);
	});
});
