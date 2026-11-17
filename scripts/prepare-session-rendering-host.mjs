#!/usr/bin/env node
/** Freeze the existing renderer build (no rebuild) for isolated production-mode measurements.
 * Run against the checked DEV diagnostic shell; copies only build/resources and its DEV shell.
 * Adds diagnostic exports to the copied JS, never to project source or release artifacts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { transform } from "esbuild";
import { suiteRoot } from "./performance/paths.mjs";
import { connect } from "./session-rendering-cdp.mjs";

const after = process.argv.includes("--after");
const repo = resolve(import.meta.dirname, ".."),
	root = suiteRoot(repo, "rendering", ".local/tmp/session-rendering-baseline", "PERCHO_RENDERING_ROOT"),
	host = resolve(root, after ? "frozen-after-host" : "frozen-host");
assert.equal(await realpath(root), root);
const main = after ? null : await connect(Number(process.env.PERCHO_INSPECT_PORT ?? 9245));
try {
	const identity = after
		? {
				agent: resolve(root, "agent"),
				exe: await realpath(resolve(root, "Percho Rendering Diagnostic.app/Contents/MacOS/Electron")),
			}
		: await main.eval(
				"({agent:process.env.PI_CODING_AGENT_DIR,exe:process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').app.getPath('exe')})",
			);
	assert.equal(identity.agent, resolve(root, "agent"));
	assert(
		identity.exe.includes(resolve(repo, ".local/runtime/dev.noindex")) ||
			(after && identity.exe === resolve(root, "Percho Rendering Diagnostic.app/Contents/MacOS/Electron")),
	);
	await mkdir(host, { recursive: true, mode: 0o700 });
	for (const directory of ["out", "build", "resources"])
		await cp(resolve(repo, "packages/desktop", directory), resolve(host, directory), { recursive: true });
	await writeFile(
		resolve(host, "package.json"),
		JSON.stringify({
			name: "percho-rendering-diagnostic",
			version: "0.6.6",
			type: "module",
			main: "out/main/index.js",
		}),
		{ mode: 0o600 },
	);
	const assets = resolve(host, "out/renderer/assets");
	const bundle = (await readdir(resolve(repo, "packages/desktop/out/renderer/assets"))).find((name) =>
		/^workbench-.*\.js$/.test(name),
	);
	assert(bundle);
	let text = await readFile(resolve(assets, bundle), "utf8");
	text +=
		"\nexport {useSessionsStore as diagSessions,useTranscriptStore as diagTranscripts,useUiStore as diagUi,useUiPreferencesStore as diagPrefs,getExecutionApi as diagApi,emptyTranscript as diagEmpty,reduceEvent as diagReduce};\n";
	if (after) text += "\nexport {useSessionViewStore as diagViews};\n";
	await transform(text, { loader: "js" });
	await writeFile(resolve(assets, bundle), text, { mode: 0o600 });
	await writeFile(
		resolve(root, after ? "production-module-after.json" : "production-module.json"),
		JSON.stringify({ file: resolve(assets, bundle) }),
		{ mode: 0o600 },
	);
	const sourceBundle = resolve(dirname(identity.exe), "../..");
	const shell = resolve(root, "Percho Rendering Diagnostic.app");
	if (!after) execFileSync("ditto", [sourceBundle, shell]);
	console.log("Frozen production renderer and isolated DEV shell prepared.");
} finally {
	main?.close();
}
