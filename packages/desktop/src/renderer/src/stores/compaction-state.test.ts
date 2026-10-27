import { emptyTranscript, reduceEvent } from "@percho/shared";
import { describe, expect, it } from "vitest";

describe("compaction pause state", () => {
	it("preserves a pause and its queue after late settled and clears it on explicit recovery", () => {
		let state = reduceEvent(emptyTranscript(), { type: "queue_update", steering: [], followUp: ["pending"] });
		state = reduceEvent(state, { type: "compaction_start", reason: "threshold" });
		state = reduceEvent(state, {
			type: "compaction_pause",
			pause: { reason: "failed", errorMessage: "network unavailable" },
		});
		state = reduceEvent(state, { type: "agent_settled", aborted: false });
		expect(state).toMatchObject({
			compactionPause: { reason: "failed" },
			followUpQueue: ["pending"],
			compacting: false,
			agentActive: false,
			phase: "idle",
		});
		state = reduceEvent(state, { type: "compaction_pause", pause: null });
		expect(state.compactionPause).toBeNull();
		expect(state.followUpQueue).toEqual(["pending"]);
	});

	it("shows retry progress without a premature error card, and clears it on cancellation", () => {
		let state = reduceEvent(emptyTranscript(), { type: "compaction_start", reason: "threshold" });
		state = reduceEvent(state, {
			type: "summarization_retry_scheduled",
			attempt: 2,
			maxAttempts: 3,
			delayMs: 4000,
			errorMessage: "fetch failed",
		});
		expect(state.summarizationRetry).toEqual({ attempt: 2, maxAttempts: 3, delayMs: 4000 });
		expect(state.messages.some((m) => m.kind === "error")).toBe(false);
		state = reduceEvent(state, {
			type: "compaction_end",
			reason: "threshold",
			aborted: true,
			willRetry: false,
			result: undefined,
		});
		expect(state.summarizationRetry).toBeNull();
		expect(state.compacting).toBe(false);
	});
});
