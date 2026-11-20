import { type AssistantMessage, retryAssistantCall, retryDelayMs } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompactionRequestPolicy } from "../src/tools/compaction-guard/request-policy";

const failure: AssistantMessage = {
	role: "assistant",
	api: "openai-completions",
	provider: "test",
	model: "test",
	timestamp: 1,
	content: [],
	stopReason: "error",
	errorMessage: "fetch failed",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

afterEach(() => vi.useRealTimers());

describe("request retry policy", () => {
	const policies = {
		request: () => SettingsManager.inMemory().getRetrySettings(),
		summary: () => createCompactionRequestPolicy("unused").retry,
	};

	for (const [name, getPolicy] of Object.entries(policies)) {
		it(`${name} retries five times with exponential backoff, then stops`, async () => {
			vi.useFakeTimers();
			const policy = getPolicy();
			expect(policy.enabled).toBe(true);
			expect(policy.maxRetries).toBe(5);
			expect(Array.from({ length: 5 }, (_, i) => retryDelayMs(policy, i + 1))).toEqual([
				2000, 4000, 8000, 16000, 32000,
			]);
			const produce = vi.fn(async () => failure);
			const pending = retryAssistantCall(produce, policy, undefined);
			await vi.runAllTimersAsync();
			expect(await pending).toBe(failure);
			expect(produce).toHaveBeenCalledTimes(6);
		});
	}

	it("preserves explicit SDK retry settings", () => {
		expect(SettingsManager.inMemory({ retry: { maxRetries: 2 } }).getRetrySettings().maxRetries).toBe(2);
	});
});
