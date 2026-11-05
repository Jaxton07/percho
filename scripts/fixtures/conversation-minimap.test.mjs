import assert from "node:assert/strict";
import test from "node:test";
import { parseOptions } from "../check-conversation-minimap.mjs";
import { summarize } from "../report-conversation-minimap.mjs";
import { sessionJsonl } from "./conversation-minimap.mjs";

test("fixtures are deterministic, complete SDK chains", () => {
	for (const n of [20, 120, 1000]) {
		const jsonl = sessionJsonl(n, "/isolated/project");
		assert.equal(jsonl, sessionJsonl(n, "/isolated/project"));
		const entries = jsonl.trimEnd().split("\n").map(JSON.parse);
		assert.equal(entries.length, 1 + n * 2);
		assert.equal(entries[0].id, `review-${n}`);
		assert.equal(entries[0].cwd, "/isolated/project");
		for (let i = 1; i < entries.length; i++) {
			assert.equal(entries[i].parentId, i === 1 ? null : entries[i - 1].id);
			assert.equal(entries[i].message.role, i % 2 ? "user" : "assistant");
		}
	}
});

test("options require ownership and bounded, distinct numeric arguments", () => {
	const args = ["--task=x", "--owner=abcdefghijklmnop"];
	const options = parseOptions(args);
	assert.deepEqual(options.turns, [20, 120, 1000]);
	assert.equal(options.rounds, 3);
	assert.equal(options.switches, 30);
	for (const extra of ["--cdp=9225", "--rounds=0", "--turns=20,20", "--switches=2x", "--other=1"])
		assert.throws(() => parseOptions([...args, extra]));
	assert.throws(() => parseOptions(["--task=x", "--owner=short"]));
	assert.throws(() => sessionJsonl(0, "/isolated/project"));
	assert.equal(parseOptions([...args, "--module=copy.js"]).module, "copy.js");
});

test("reports preserve mode boundaries and count input latency only during streaming", () => {
	const sample = {
		name: "stream-1000",
		elapsedMs: 3000,
		frames: [8, 9, 10],
		longTasks: [],
		rows: 6,
		railMounted: 65,
		inputs: [
			{ ms: 12, duringStream: true },
			{ ms: 999, duringStream: false },
		],
	};
	const result = summarize([
		{ mode: "dev", samples: [sample, { ...sample, elapsedMs: 3200 }] },
		{ mode: "built-renderer", samples: [{ ...sample, inputs: [] }] },
	]);
	assert.equal(result.length, 2);
	assert.equal(result[0].count, 2);
	assert.equal(result[0].medianMs, 3000);
	assert.equal(result[0].p95Ms, 3200);
	assert.equal(result[0].inputP95Ms, 12);
	assert.equal(result[1].inputP95Ms, null);
});
