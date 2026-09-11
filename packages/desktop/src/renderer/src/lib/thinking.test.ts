import { isThinkingLevel } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { clampThinkingLevel, THINKING_LEVELS } from "./thinking";

describe("thinking 档位（shared 白名单 + renderer 收敛）", () => {
	it("白名单恰为 7 档，非法值一律拒绝", () => {
		expect(THINKING_LEVELS).toHaveLength(7);
		for (const level of THINKING_LEVELS) expect(isThinkingLevel(level)).toBe(true);
		expect(isThinkingLevel("ultra")).toBe(false);
		expect(isThinkingLevel("")).toBe(false);
		expect(isThinkingLevel(undefined)).toBe(false);
		expect(isThinkingLevel(3)).toBe(false);
	});

	it("clampThinkingLevel 就近向上 + supported 末位回退（仅 renderer UI 用；backend 交 SDK clamp）", () => {
		expect(clampThinkingLevel("medium", ["low", "medium", "high"])).toBe("medium");
		expect(clampThinkingLevel("high", ["low", "xhigh"])).toBe("xhigh");
		expect(clampThinkingLevel("max", ["off", "low"])).toBe("low");
		expect(clampThinkingLevel("ultra", ["low", "high"])).toBe("high");
		expect(clampThinkingLevel("high", [])).toBe("high");
	});
});
