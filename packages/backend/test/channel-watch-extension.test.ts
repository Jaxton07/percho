import { describe, expect, it } from "vitest";
import {
	buildSubsPayload,
	restoreSubscriptionState,
	restoreSubscriptions,
	SUBSCRIPTION_CUSTOM_TYPE,
} from "../src/tools/channel-watch/subscriptions";

const entry = (data: unknown) => ({ type: "custom", customType: SUBSCRIPTION_CUSTOM_TYPE, data });

describe("legacy JSONL subscription recovery", () => {
	it("sorts and filters payloads and restores the last valid snapshot, including unsubscribe", () => {
		const payload = buildSubsPayload(
			["b", "a", "../bad", "a"],
			new Map([
				["a", null],
				["b", "h"],
			]),
		);
		expect(payload).toEqual({ topics: ["a", "b"], cursors: { a: null, b: "h" } });
		expect(restoreSubscriptions([entry(payload), entry({ topics: "bad" })])).toEqual(new Set(["a", "b"]));
		expect(restoreSubscriptions([entry(payload), entry({ topics: [] })])).toEqual(new Set());
	});
	it("restores topics and cursors together, filtering invalid values and obsolete keys", () => {
		const state = restoreSubscriptionState([
			entry({ topics: ["old"], cursors: { old: "old" } }),
			entry({ topics: ["a", "b", "", 7], cursors: { a: null, b: "h", gone: "h" } }),
			entry({ topics: "bad" }),
		]);
		expect(state.topics).toEqual(["a", "b"]);
		expect([...state.cursors]).toEqual([
			["a", null],
			["b", "h"],
		]);
		expect(
			restoreSubscriptionState([entry({ topics: ["a", "b"], cursors: { a: 123, b: "h" } })]).cursors,
		).toEqual(new Map([["b", "h"]]));
	});
	it("distinguishes old topics-only payloads from explicit null and tolerates malformed input", () => {
		expect(restoreSubscriptionState([entry({ topics: ["a"] })]).cursors.has("a")).toBe(false);
		expect(
			restoreSubscriptionState([entry({ topics: ["a"], cursors: { a: null } })]).cursors.get("a"),
		).toBeNull();
		expect(restoreSubscriptions(null)).toEqual(new Set());
		expect(
			restoreSubscriptions([{ type: "custom", customType: "other", data: {} }, entry(undefined)]),
		).toEqual(new Set());
	});
});
