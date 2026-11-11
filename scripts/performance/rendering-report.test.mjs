import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeRenderingRuns } from "./rendering-report.mjs";

const sample = (stage, width = 1280, height = 800) => ({
	stage,
	width,
	height,
	dpr: 2,
	elements: 30,
	frames: [10, 20],
	inputs: [12],
});
test("rendering contracts preserve intentional per-stage viewport changes", () => {
	const { viewport, metrics } = summarizeRenderingRuns([
		{ label: "performance", report: { samples: [sample("empty"), sample("empty")] } },
		{
			label: "interactions",
			report: { samples: [sample("empty"), sample("narrow", 640), sample("narrow", 640)] },
		},
	]);
	assert.deepEqual(viewport.initial, { width: 1280, height: 800, dpr: 2 });
	assert.equal(viewport.stages["interactions:narrow"].width, 640);
	assert.equal(metrics.find((point) => point.name === "performance.empty.frameP95Ms").value, 20);
});
test("mount latency is retained independently from open and expand", () => {
	const { metrics } = summarizeRenderingRuns([
		{ label: "performance", report: { samples: [{ ...sample("mount"), mountRoundTripMs: 42 }] } },
	]);
	assert.equal(metrics.find((point) => point.name === "performance.mount.mountP95Ms")?.value, 42);
});
test("different independent host viewports and drifting same-stage samples are rejected", () => {
	assert.throws(
		() =>
			summarizeRenderingRuns([
				{ label: "one", report: { samples: [sample("empty")] } },
				{ label: "two", report: { samples: [sample("empty", 1440)] } },
			]),
		/viewport/i,
	);
	assert.throws(
		() =>
			summarizeRenderingRuns([
				{ label: "one", report: { samples: [sample("steady"), sample("steady", 1280, 900)] } },
			]),
		/viewport/i,
	);
	assert.throws(
		() =>
			summarizeRenderingRuns([
				{ label: "bad", report: { samples: [{ ...sample("empty"), inputs: [NaN] }] } },
			]),
		/input/i,
	);
});
