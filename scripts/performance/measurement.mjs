import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Bind orchestration and summaries as well as each suite's fixture/collector contract. */
export async function measurementFingerprint(repo) {
	const hash = createHash("sha256");
	const files = [
		...[
			"cli",
			"suites",
			"process",
			"desktop",
			"owned-task",
			"checkpoint",
			"large-text",
			"rendering-report",
			"measurement",
			"artifacts",
			"paths",
		].map((name) => `scripts/performance/${name}.mjs`),
		"scripts/session-rendering-cdp.mjs",
		"scripts/session-rendering-resources.mjs",
		"scripts/session-rendering-view-state.mjs",
		"scripts/prepare-conversation-minimap-host.mjs",
		"scripts/prepare-session-rendering-host.mjs",
		"packages/desktop/src/main/session-switch-diagnostics.ts",
		"packages/desktop/src/renderer/src/lib/run-session-switch-diagnostics.ts",
	];
	for (const file of files) hash.update(file).update(await readFile(join(repo, file)));
	return hash.digest("hex");
}
