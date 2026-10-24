/** Force the packaged image worker + Photon WASM to run; an in-process fallback is not a pass. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";

if (process.platform !== "linux" || process.env.PERCHO_RUNTIME_TEST_ENTRY !== "/runtime/entry.mjs")
	throw new Error("Standalone Linux fixture required");
process.env.PI_CODING_AGENT_DIR = "/state/image-worker-agent";
process.env.PI_PACKAGE_DIR = "/runtime/node_modules/@earendil-works/pi-coding-agent";
const threads = createRequire(import.meta.url)("node:worker_threads"),
	OriginalWorker = threads.Worker;
let workers = 0,
	replies = 0,
	errors = 0;
threads.Worker = class extends OriginalWorker {
	constructor(...args) {
		super(...args);
		workers++;
		this.on("error", () => {
			errors++;
		});
		this.on("message", (value) => {
			if (value?.type === "pi:image-resize-response" && !value.error) replies++;
		});
	}
};
syncBuiltinESMExports();
try {
	const { resizeImage } = await import("/runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
	const result = await resizeImage(await readFile("/state/image-project/noise.png"), "image/png", {
		maxWidth: 64,
		maxHeight: 64,
	});
	assert.equal(result?.width, 64);
	assert.equal(result?.height, 64);
	assert.equal(result?.wasResized, true);
	assert.equal(workers, 1);
	assert.equal(replies, 1);
	assert.equal(errors, 0);
	console.log(
		JSON.stringify({
			passed: true,
			arch: process.arch,
			packagedImageWorker: true,
			photonWasm: true,
			noFallback: true,
		}),
	);
} finally {
	threads.Worker = OriginalWorker;
	syncBuiltinESMExports();
}
