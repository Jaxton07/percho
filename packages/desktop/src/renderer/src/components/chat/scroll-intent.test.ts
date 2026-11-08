import { describe, expect, it } from "vitest";
import { type ScrollIntentIdentity, scrollIntentIsCurrent } from "./scroll-intent";

describe("scroll intent identity", () => {
	it("rejects delayed work after A → B → A, reopening, or a newer gesture", async () => {
		let current: ScrollIntentIdentity = {
			sessionId: "env:A",
			openEpoch: 1,
			historyGeneration: 5,
			sequence: 1,
		};
		const valid = scrollIntentIsCurrent({ ...current }, () => current);
		let complete!: () => void;
		const pending = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const positions: string[] = [];
		const work = pending.then(() => {
			if (valid()) positions.push("old jump");
		});
		current = { ...current, sessionId: "env:B", sequence: 2 };
		expect(valid()).toBe(false);
		current = { ...current, sessionId: "env:A", sequence: 3 };
		complete();
		await work;
		expect(positions).toEqual([]);
		current = { ...current, sequence: 1, openEpoch: 2 };
		expect(valid()).toBe(false);
		current = { ...current, openEpoch: 1, historyGeneration: 6 };
		expect(valid()).toBe(false);
	});

	it("keeps a page prepend valid while rejecting a new bottom or jump intent", () => {
		let current = { sessionId: "env:A", openEpoch: 1, historyGeneration: 5, sequence: 7 };
		const valid = scrollIntentIsCurrent({ ...current }, () => current);
		expect(valid()).toBe(true);
		current = { ...current, sequence: 8 };
		expect(valid()).toBe(false);
	});
});
