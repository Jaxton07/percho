import { deriveTurnSpeed } from "@percho/shared";
import { describe, expect, it } from "vitest";

describe("deriveTurnSpeed", () => {
	it("聚合轮内样本：speed = Σ 输出 token ÷ Σ 生成耗时", () => {
		const info = deriveTurnSpeed([
			{ output: 1510, durationMs: 41212 },
			{ output: 500, durationMs: 20000 },
		]);
		expect(info).toEqual({
			outputTokens: 2010,
			durationMs: 61212,
			speed: 2010 / (61212 / 1000),
			samples: 2,
		});
	});

	it("空样本 / 缺字段 → null（宁缺勿错）", () => {
		expect(deriveTurnSpeed([])).toBeNull();
		expect(deriveTurnSpeed([{ output: undefined, durationMs: 100 }])).toBeNull();
		expect(deriveTurnSpeed([{ output: 10, durationMs: undefined }])).toBeNull();
		expect(deriveTurnSpeed([{ output: "10", durationMs: 100 }])).toBeNull();
	});

	it("拒绝无效数值样本", () => {
		expect(deriveTurnSpeed([{ output: Number.NaN, durationMs: 100 }])).toBeNull();
		expect(deriveTurnSpeed([{ output: -1, durationMs: 100 }])).toBeNull();
		expect(deriveTurnSpeed([{ output: 10, durationMs: 0 }])).toBeNull();
		expect(deriveTurnSpeed([{ output: 10, durationMs: Number.POSITIVE_INFINITY }])).toBeNull();
	});

	it("拒绝 >1000 tok/s 的不可信样本（output > durationMs）；有效样本仍计入", () => {
		expect(deriveTurnSpeed([{ output: 1500, durationMs: 1000 }])).toBeNull();
		const info = deriveTurnSpeed([
			{ output: 1500, durationMs: 1000 },
			{ output: 100, durationMs: 5000 },
		]);
		expect(info).toEqual({ outputTokens: 100, durationMs: 5000, speed: 20, samples: 1 });
	});

	it("排除 stopReason 为 error 的失败消息（重试轮失败尝试会稀释速度）", () => {
		const info = deriveTurnSpeed([
			{ output: 50, durationMs: 2000, stopReason: "error" },
			{ output: 200, durationMs: 8000, stopReason: "stop" },
		]);
		expect(info).toEqual({ outputTokens: 200, durationMs: 8000, speed: 25, samples: 1 });
		expect(deriveTurnSpeed([{ output: 50, durationMs: 2000, stopReason: "error" }])).toBeNull();
	});

	it("边界值 output === durationMs（恰好 1000 tok/s）可接受", () => {
		const info = deriveTurnSpeed([{ output: 1000, durationMs: 1000 }]);
		expect(info).toEqual({ outputTokens: 1000, durationMs: 1000, speed: 1000, samples: 1 });
	});
});
