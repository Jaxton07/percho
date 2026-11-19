import { CHAT_COLUMN_DEFAULT_WIDTH, CHAT_COLUMN_MIN_WIDTH, normalizeChatColumnWidth } from "@percho/shared";
import { describe, expect, it } from "vitest";

describe("normalizeChatColumnWidth", () => {
	it("exports the default and minimum intended widths", () => {
		expect(CHAT_COLUMN_DEFAULT_WIDTH).toBe(760);
		expect(CHAT_COLUMN_MIN_WIDTH).toBe(480);
	});

	it.each([
		[480, 480],
		[760, 760],
		[812.4, 812],
		[812.5, 813],
		[479.9, 480],
		[0, 480],
		[-100, 480],
		[10000, 10000],
		[Number.MAX_VALUE, Number.MAX_VALUE],
	])("normalizes finite %s to %s without a fixed maximum", (value, expected) => {
		expect(normalizeChatColumnWidth(value)).toBe(expected);
	});

	it.each([undefined, null, "900", "", true, false, [], [900], {}, Number.NaN, Infinity, -Infinity])(
		"falls back to the default for invalid value %s",
		(value) => {
			expect(normalizeChatColumnWidth(value)).toBe(760);
		},
	);
});
