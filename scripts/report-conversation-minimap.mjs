#!/usr/bin/env node
/** Summarize collector JSON without exposing fixture text, paths or ownership tokens. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function percentile(values, ratio) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] * 10) / 10;
}

export function summarize(results) {
	const groups = new Map();
	for (const report of results) {
		for (const sample of report.samples) {
			const key = `${report.mode}:${sample.name}`;
			const group = groups.get(key) ?? [];
			group.push(sample);
			groups.set(key, group);
		}
	}
	return [...groups].map(([name, samples]) => ({
		name,
		count: samples.length,
		medianMs: percentile(
			samples.map((sample) => sample.elapsedMs),
			0.5,
		),
		p95Ms: percentile(
			samples.map((sample) => sample.elapsedMs),
			0.95,
		),
		frameP95Ms: percentile(
			samples.flatMap((sample) => sample.frames),
			0.95,
		),
		longTasks: samples.reduce((sum, sample) => sum + sample.longTasks.length, 0),
		maxRows: Math.max(...samples.map((sample) => sample.rows)),
		maxRailMounted: Math.max(...samples.map((sample) => sample.railMounted)),
		inputP95Ms: samples.some((sample) => sample.inputs?.length)
			? percentile(
					samples
						.flatMap((sample) => sample.inputs ?? [])
						.filter((input) => input.duringStream)
						.map((input) => input.ms),
					0.95,
				)
			: null,
	}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const files = process.argv.slice(2);
	if (!files.length) throw new Error("Pass one or more collector JSON files");
	const results = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
	console.log(JSON.stringify(summarize(results), null, 2));
}
