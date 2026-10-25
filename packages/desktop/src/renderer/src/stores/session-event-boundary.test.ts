import { type EnvironmentRef, environmentEntityKey } from "@percho/shared";
import { describe, expect, it } from "vitest";
import {
	acceptSessionEvent,
	beginSessionBaseline,
	failSessionBaseline,
	finishSessionBaseline,
	isSessionSynchronizing,
	onSessionBoundaryReset,
	pauseEnvironmentEvents,
	pendingSessionBaselineToken,
	resumeEnvironmentEvents,
} from "./session-event-boundary";

const env: EnvironmentRef = { kind: "ssh", connectionId: "boundary", environmentId: "data" };
describe("baseline event boundary", () => {
	it("drops covered events and old generations while preserving increments captured during transfer", () => {
		const id = environmentEntityKey(env, "a"),
			applied: string[] = [];
		const off = onSessionBoundaryReset((session) => {
			if (session === id) applied.push("reset");
		});
		try {
			const old = beginSessionBaseline(id),
				current = beginSessionBaseline(id);
			acceptSessionEvent(id, 10, { text: "covered" }, () => applied.push("covered"));
			acceptSessionEvent(id, 11, { text: "next" }, () => applied.push("next"));
			expect(finishSessionBaseline(id, old, 9, () => applied.push("old"))).toBe(false);
			finishSessionBaseline(id, current, 10, () => applied.push("baseline"));
			acceptSessionEvent(id, 10, {}, () => applied.push("late"));
			acceptSessionEvent(id, 12, {}, () => applied.push("live"));
			expect(applied).toEqual(["reset", "reset", "reset", "baseline", "next", "live"]);
		} finally {
			off();
		}
	});
	it("holds newly discovered registry sessions during initial sync and fails closed on buffer overflow", () => {
		const id = environmentEntityKey(env, "unpersisted"),
			effects: string[] = [];
		pauseEnvironmentEvents(env);
		acceptSessionEvent(id, 1, {}, () => effects.push("new"));
		const token = pendingSessionBaselineToken(id);
		expect(token).toBeDefined();
		expect(effects).toEqual([]);
		finishSessionBaseline(id, token as number, 0, () => effects.push("summary"));
		resumeEnvironmentEvents(env);
		expect(effects).toEqual(["summary", "new"]);
		const overflow = beginSessionBaseline(id);
		for (let i = 0; i < 8193; i++) acceptSessionEvent(id, i + 2, {}, () => effects.push("unexpected"));
		expect(() => finishSessionBaseline(id, overflow, 0, () => effects.push("partial"))).toThrow(
			"buffer exceeded",
		);
		expect(isSessionSynchronizing(id)).toBe(true);
		failSessionBaseline(id, overflow);
		expect(effects).toEqual(["summary", "new"]);
	});
});
