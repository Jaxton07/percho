/** Chrome emits chunks on the profiler thread; Profile identifies the sampled thread. */
import assert from "node:assert/strict";
export function summarizeRenderingTrace(events) {
	const mainThreads = new Set(
		events
			.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain")
			.map((e) => `${e.pid}:${e.tid}`),
	);
	const profiles = new Set(
		events
			.filter((e) => e.name === "Profile" && mainThreads.has(`${e.pid}:${e.tid}`))
			.map((e) => `${e.pid}:${e.id}`),
	);
	assert(profiles.size, "Renderer profile metadata is required for attribution");
	const nodes = new Map(),
		samples = [];
	for (const event of events) {
		const prefix = `${event.pid}:${event.id}`;
		if (!profiles.has(prefix)) continue;
		const profile = event.args?.data?.cpuProfile;
		if (!profile) continue;
		for (const node of profile.nodes ?? [])
			nodes.set(`${prefix}:${node.id}`, node.callFrame?.functionName || "(anonymous)");
		for (const id of profile.samples ?? []) samples.push(`${prefix}:${id}`);
	}
	const counts = new Map();
	for (const id of samples) {
		const name = nodes.get(id) ?? "(unresolved)";
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return {
		sampleScope: "CrRendererMain profile only; self sample counts are not wall time or frame percentages",
		traceEvents: events.length,
		cpuSamples: samples.length,
		topSelfSamples: [...counts]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 25)
			.map(([name, count]) => ({ name, count })),
	};
}
