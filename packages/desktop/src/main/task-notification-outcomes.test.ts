import { reduceTaskRun, type SessionEvent, type TaskRunState } from "@percho/shared";
import { describe, expect, it } from "vitest";

const event = (value: object) => value as SessionEvent;
const start = { type: "agent_start" },
	end = { type: "agent_end", willRetry: false, messages: [] },
	settled = { type: "agent_settled", aborted: false };
const success = { type: "turn_end", message: { role: "assistant", stopReason: "stop" } };
const error = {
	type: "turn_end",
	message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" },
};
function outcomes(events: object[]) {
	let state: TaskRunState | undefined;
	const results: string[] = [];
	for (const value of events) {
		const next = reduceTaskRun(state, event(value));
		state = next.state;
		if (next.outcome) results.push(next.outcome);
	}
	return results;
}
describe("whole task outcome boundaries", () => {
	it("emits once for multiple internally consumed follow-ups", () => {
		expect(outcomes([start, success, success, success, end, settled, settled])).toEqual(["completed"]);
	});
	it("does not split continue requests or report an intermediate retry error", () => {
		expect(
			outcomes([
				start,
				error,
				{ ...end, willRetry: true },
				start,
				success,
				end,
				start,
				success,
				end,
				settled,
			]),
		).toEqual(["completed"]);
	});
	it("reports final failure, including a pending error without agent_end", () => {
		expect(outcomes([start, error, end, settled, settled])).toEqual(["failed"]);
		expect(outcomes([start, error, settled])).toEqual(["failed"]);
	});
	it("suppresses active retries, missing terminal evidence and user cancellation", () => {
		expect(outcomes([start, error, { ...end, willRetry: true }, settled])).toEqual([]);
		expect(outcomes([start, settled])).toEqual([]);
		expect(outcomes([start, success, end, { ...settled, aborted: true }])).toEqual([]);
		expect(
			outcomes([
				start,
				{ ...error, message: { ...error.message, errorMessage: "Request aborted" } },
				end,
				settled,
			]),
		).toEqual([]);
	});
	it("separates protection failure from an abort requested by the user", () => {
		expect(
			outcomes([start, { type: "stream_guard_tripped", verdict: {} }, { ...settled, aborted: true }]),
		).toEqual(["failed"]);
	});
	it("does not announce pauses, and counts a genuine later run independently", () => {
		expect(
			outcomes([
				start,
				success,
				end,
				{ type: "compaction_pause", pause: {} },
				settled,
				start,
				success,
				end,
				settled,
			]),
		).toEqual(["completed"]);
	});
});
