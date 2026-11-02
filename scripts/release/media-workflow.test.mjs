import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { nativeApp } from "./plan.mjs";

test("Windows media probe uses the actual packaging output, not the macOS build.noindex directory", async () => {
	const workflow = await readFile(
		new URL("../../.github/workflows/desktop-package.yml", import.meta.url),
		"utf8",
	);
	const output = workflow.match(/npm run package:release[^\n]*--output (\S+)/)?.[1];
	const probe = workflow.match(/check-session-media-package\.mjs --build-output (\S+)/)?.[1];
	assert(output && probe, "Packaging and media probe commands must both be present");
	assert.equal(resolve(probe, "win-unpacked"), nativeApp(output, "win32", "x64", "Percho"));
});
