#!/usr/bin/env node
/** Three-second CPU/timeline sample on the checked isolated rendering fixture instance.
 * Raw trace stays private under .local/tmp; share only the counter/function-name summary.
 * Does not stop or alter the running fixture. Run before and after at a matching loaded scale.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connect } from "./session-rendering-cdp.mjs";
import { summarizeRenderingTrace } from "./session-rendering-trace-summary.mjs";

const root = resolve(import.meta.dirname, "../.local/tmp/session-rendering-baseline");
const label = process.argv[2] ?? "baseline";
assert.match(label, /^[a-z-]+$/);
const main = await connect(9245),
	renderer = await connect(9244);
try {
	const dir = await main.eval("process.env.PI_CODING_AGENT_DIR");
	assert.equal(dir, resolve(root, "agent"));
	const before = await main.eval(
		"({index:__renderReplay.index,total:__renderReplay.events.length,age:Date.now()-__renderReplay.started})",
	);
	const completed = new Promise((resolve) => renderer.on("Tracing.tracingComplete", resolve));
	await renderer.send("Tracing.start", {
		categories: "devtools.timeline,v8.execute,disabled-by-default-v8.cpu_profiler",
		transferMode: "ReturnAsStream",
	});
	await new Promise((r) => setTimeout(r, 3000));
	await renderer.send("Tracing.end");
	const { stream } = await completed;
	let raw = "";
	try {
		for (;;) {
			const part = await renderer.send("IO.read", { handle: stream, size: 1024 * 1024 });
			raw += part.base64Encoded ? Buffer.from(part.data, "base64").toString() : part.data;
			if (part.eof) break;
		}
	} finally {
		await renderer.send("IO.close", { handle: stream });
	}
	await writeFile(resolve(root, `${label}-private-trace.json`), raw, { mode: 0o600 });
	const summary = {
		before,
		...summarizeRenderingTrace(JSON.parse(raw).traceEvents),
	};
	await writeFile(resolve(root, `${label}-trace-summary.json`), JSON.stringify(summary, null, 2), {
		mode: 0o600,
	});
	console.log(JSON.stringify(summary, null, 2));
} finally {
	renderer.close();
	main.close();
}
