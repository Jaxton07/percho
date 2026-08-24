import type { NudgeDecision } from "acp-kernel";
import { describe, expect, it } from "vitest";
import { buildNudgeMessage, nudgeTextFor, nudgeTurnKey } from "../src/tools/acp-context/nudge";

function decision(overrides: Partial<NudgeDecision> = {}): NudgeDecision {
	return {
		shouldInject: true,
		reason: "OVER-LIMIT T1: max effective pending 52000, usage 78%",
		compressibleRanges: [
			{
				startRef: "m00002",
				endRef: "m00042",
				count: 41,
				tokens: 52000,
				chars: 208000,
				toolPct: 0.7,
				textPct: 0.3,
			},
		],
		protectedRanges: [{ startRef: "m00043", endRef: "m00045", count: 3, tokens: 1200, tools: ["todo"] }],
		contextUsage: 0.78,
		tier: 1,
		breakdown: {
			usage: 0.78,
			growth: 0,
			growthReference: 0,
			effectiveThreshold: 0,
			nudgeGrowthTokens: 50000,
			growthFloor: 22500,
			hasPendingNudge: 0,
			overLimit: 1,
			emergencyOverride: 0,
			pendingT1: 52000,
			pendingT2: 0,
			pendingT3: 0,
		},
		...overrides,
	};
}

describe("buildNudgeMessage", () => {
	it("无块：决策文本 + 可压范围 + example 调用", () => {
		const message = buildNudgeMessage(decision(), []);
		const text = String(message.content);
		expect(message.role).toBe("user");
		expect(text).toContain("compress");
		expect(text).toContain("Compressible ranges:");
		expect(text).toContain('Example: compress({ content: [{ startId: "m00002", endId: "m00042"');
		expect(text).not.toContain("Compressed blocks:");
	});

	it("有块：附加活块状态行（tier 计数 / 摘要体积 / 块 id）", () => {
		const message = buildNudgeMessage(decision(), [
			{
				blockId: "b1",
				runId: "r1",
				tier: 1,
				topic: "auth work",
				summary: "s".repeat(400),
				directMessageIds: ["e1"],
				effectiveMessageIds: ["e1"],
				directBlockIds: [],
				compressedTokens: 21000,
				createdAt: 1,
				survivedCount: 2,
				generation: "young",
				active: true,
			},
		]);
		const text = String(message.content);
		expect(text).toContain("Compressed blocks: 1 active (T1:1)");
		expect(text).toContain("21.0K original compressed");
		expect(text).toContain("b1");
	});

	it("无可压范围时不给 example 调用（避免误导）", () => {
		const text = nudgeTextFor(decision({ compressibleRanges: [] }), []);
		expect(text).not.toContain("Example: compress(");
	});
});

describe("nudgeTurnKey", () => {
	it("取最后一条 user 消息 id；无 user 用 fallback", () => {
		const key = nudgeTurnKey(
			[
				{ role: "user", id: "u1" },
				{ role: "assistant", id: "a1" },
				{ role: "tool", id: "t1" },
				{ role: "user", id: "u2" },
				{ role: "assistant", id: "a2" },
			],
			"fallback",
		);
		expect(key).toBe("u2");
		expect(nudgeTurnKey([{ role: "assistant", id: "a1" }], "fallback")).toBe("fallback");
		expect(nudgeTurnKey([], "fallback")).toBe("fallback");
	});
});
