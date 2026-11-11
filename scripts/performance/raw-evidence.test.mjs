import assert from "node:assert/strict";
import { test } from "node:test";
import { validRawEvidence } from "./raw-evidence.mjs";

const examples = {
	minimap: {
		mode: "built-renderer",
		window: { width: 800, height: 600, dpr: 1 },
		samples: [{ name: "open", elapsedMs: 1 }],
	},
	rendering: { label: "smoke", samples: [{ stage: "open", elements: 1 }] },
	"large-text": {
		status: "passed",
		samples: [{ navigation: 1, ready: 2, firstPaint: 3, views: 0, warmup: false }],
	},
	switch: {
		version: 2,
		summary: [{ fixture: "text", firstPaint: { p50: 1 } }],
		samples: [{ fixture: "text", firstPaint: { ms: 1 } }],
	},
	images: { cases: [{ mode: "inline", imageCount: 1 }] },
	catalog: { phases: [{ phase: "first", refreshTotalMs: 1 }], budgetFailures: [] },
};

test("known suite shapes accept completed samples and reject empty or failed evidence", () => {
	for (const [name, value] of Object.entries(examples)) {
		assert.equal(validRawEvidence(name, value), true, name);
		assert.equal(validRawEvidence(name, {}), false, name);
		for (const status of ["failed", "running", "partial", "interrupted"]) {
			assert.equal(validRawEvidence(name, { ...value, status }), false, `${name}: ${status}`);
		}
		const key = name === "images" ? "cases" : name === "catalog" ? "phases" : "samples";
		assert.equal(validRawEvidence(name, { ...value, [key]: [] }), false, name);
		assert.equal(validRawEvidence(name, { ...value, [key]: [{}] }), false, name);
		assert.equal(
			validRawEvidence(name, { ...value, [key]: [{ ...value[key][0], status: "failed" }] }),
			false,
			name,
		);
	}
	assert.equal(
		validRawEvidence("switch", { ...examples.switch, samples: [{ fixture: "text", firstPaint: 1 }] }),
		true,
	);
	assert.equal(validRawEvidence("switch", { ...examples.switch, summary: [] }), false);
	assert.equal(validRawEvidence("catalog", { ...examples.catalog, budgetFailures: ["over budget"] }), false);
	assert.equal(validRawEvidence("unknown", examples.switch), false);
	const { status, ...oldLargeText } = examples["large-text"];
	assert.equal(status, "passed");
	assert.equal(validRawEvidence("large-text", { ...oldLargeText, version: 1 }), true);
	assert.equal(validRawEvidence("large-text", { ...oldLargeText, version: 2 }), false);
});
