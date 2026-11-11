#!/usr/bin/env node
/** Freeze a built renderer in an isolated host; never edits source or release artifacts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { transform } from "esbuild";
import { validateWorkPath } from "./performance/paths.mjs";
import { connect } from "./session-rendering-cdp.mjs";

const root = resolve(import.meta.dirname, "..");
const options = Object.fromEntries(process.argv.slice(2).map((argument) => argument.slice(2).split("=")));
if (process.argv.includes("--help")) {
	console.log(`Build the renderer first, then connect to an OWNED isolated dev shell:
node scripts/prepare-conversation-minimap-host.mjs --task=<fresh .local/tmp directory>
  --owner=<running shell MINIMAP_OWNER> [--source=<checkout>] [--inspect=9225]
This copies out/build/resources and the owned DEV shell; it never launches or stops it.
Quit that shell, then launch <task>/Diagnostic.app/Contents/MacOS/Electron with <task>/host,
PERCHO_AGENT_DIR=<task>/agent, MINIMAP_OWNER=<new token>, remote debugging and --inspect,
--user-data-dir=<task>/user-data. Unset ELECTRON_RENDERER_URL. Use the descriptor's module
with check-conversation-minimap --module. Its --source must match the launched cwd.
All measurement is built-renderer diagnostic mode, not a signed release-package test.`);
	process.exit(0);
}
assert(options.task && options.owner, "Specify task and owner");
const task = resolve(options.task);
if (!task.startsWith(join(root, ".local/tmp") + sep)) validateWorkPath(root, task);
await mkdir(task, { recursive: true, mode: 0o700 });
assert.equal(await realpath(task), task);
const source = await realpath(options.source ?? root);
const main = await connect(Number(options.inspect ?? 9225));
try {
	const identity = await main.eval(
		"(()=>{const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');return {owner:process.env.MINIMAP_OWNER,exe:e.app.getPath('exe'),agent:process.env.PI_CODING_AGENT_DIR,cwd:process.cwd()}})()",
	);
	assert.equal(identity.owner, options.owner);
	assert.equal(await realpath(identity.cwd), await realpath(join(source, "packages/desktop")));
	if (task.startsWith(join(root, ".local/tmp") + sep))
		assert(identity.agent.startsWith(join(root, ".local/tmp") + sep));
	else assert.equal(identity.agent, join(task, "agent"));
	assert(identity.exe.includes(`${sep}.local${sep}runtime${sep}dev.noindex${sep}`));
	const host = join(task, "host");
	await mkdir(host, { mode: 0o700 });
	for (const part of ["out", "build", "resources"])
		await cp(join(source, "packages/desktop", part), join(host, part), { recursive: true });
	await writeFile(
		join(host, "package.json"),
		JSON.stringify({
			name: "percho-minimap-diagnostic",
			version: "0.0.0",
			type: "module",
			main: "out/main/index.js",
		}),
		{ mode: 0o600 },
	);
	await symlink(join(source, "packages/desktop/node_modules"), join(host, "node_modules"), "dir");
	const assets = join(host, "out/renderer/assets");
	const bundles = (await readdir(assets)).filter((name) => /^workbench-.*\.js$/.test(name));
	assert.equal(bundles.length, 1, "Build must contain one workbench entry");
	const module = join(assets, bundles[0]);
	const code =
		(await readFile(module, "utf8")) +
		"\nexport {useSessionsStore as diagSessions,useTranscriptStore as diagTranscripts,reloadSessionHistory as diagReload,useUiPreferencesStore as diagPrefs,useUiStore as diagUi};\n";
	await transform(code, { loader: "js", format: "esm" });
	await writeFile(module, code, { mode: 0o600 });
	assert.equal(process.platform, "darwin", "Shell freezing currently supports macOS only");
	execFileSync("ditto", [resolve(dirname(identity.exe), "../.."), join(task, "Diagnostic.app")]);
	await writeFile(join(task, "module.json"), JSON.stringify({ module, host, source }), { mode: 0o600 });
	console.log("Owned built-renderer diagnostic host prepared; descriptor: module.json.");
} finally {
	main.close();
}
