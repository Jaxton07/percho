import assert from "node:assert/strict";

const quantile = (values, p) => {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
};
const viewportOf = (sample) => {
	const viewport = { width: sample.width, height: sample.height, dpr: sample.dpr };
	assert(
		Object.values(viewport).every((value) => Number.isFinite(value) && value > 0),
		"Invalid rendering viewport",
	);
	return viewport;
};
/** Converts real collector artifacts; different scenarios never share one p95. */
export function summarizeRenderingRuns(reports) {
	assert(reports.length, "Missing rendering reports");
	const initial = viewportOf(reports[0].report.samples[0]);
	const stages = new Map();
	const metrics = [];
	for (const { label, report } of reports) {
		assert(report.samples?.length, "Missing rendering samples");
		assert.deepEqual(viewportOf(report.samples[0]), initial, "Independent rendering host viewport differs");
		for (const sample of report.samples) {
			const key = `${label}:${sample.stage}`;
			const actual = viewportOf(sample);
			if (stages.has(key))
				assert.deepEqual(actual, stages.get(key), `Rendering viewport drifted within ${key}`);
			else stages.set(key, actual);
			assert(
				(sample.frames ?? []).every((value) => Number.isFinite(value) && value >= 0),
				"Invalid rendering frames",
			);
			assert(
				(sample.inputs ?? []).every((point) => Number.isFinite(typeof point === "number" ? point : point.ms)),
				"Invalid rendering input sample",
			);
			assert(Number.isFinite(sample.elements), "Invalid rendering element count");
		}
		for (const stage of new Set(report.samples.map((sample) => sample.stage))) {
			const samples = report.samples.filter((sample) => sample.stage === stage);
			for (const [name, values] of [
				["frameP95Ms", samples.flatMap((sample) => sample.frames ?? [])],
				[
					"inputP95Ms",
					samples
						.flatMap((sample) => sample.inputs ?? [])
						.map((point) => (typeof point === "number" ? point : point.ms)),
				],
				["mountP95Ms", samples.map((sample) => sample.mountRoundTripMs)],
				["openP95Ms", samples.map((sample) => sample.openRoundTripMs)],
				["expandP95Ms", samples.map((sample) => sample.expandRoundTripMs)],
			]) {
				const value = quantile(values, 0.95);
				if (value != null)
					metrics.push({ name: `${label}.${stage}.${name}`, value, unit: "ms", lowerIsBetter: true });
			}
			metrics.push({
				name: `${label}.${stage}.maxElements`,
				value: Math.max(...samples.map((sample) => sample.elements)),
				unit: "count",
				lowerIsBetter: true,
			});
		}
	}
	return { viewport: { initial, stages: Object.fromEntries(stages) }, metrics };
}
