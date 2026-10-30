import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { extractFile, listPackage } from "@electron/asar";
import channels from "../../packages/desktop/build/app-channels.json" with { type: "json" };

export async function verifyApp(app, platform, release, runtimeManifest) {
	const resources = platform === "darwin" ? join(app, "Contents/Resources") : join(app, "resources");
	const archive = join(resources, "app.asar");
	const entries = listPackage(archive).map((name) => name.replaceAll("\\", "/").replace(/^\//, ""));
	const metadata = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
	assert.equal(metadata.version, release.version, "Packaged application version");
	assert.equal(metadata.releaseChannel, release.channel, "Packaged application channel");
	assert.equal(metadata.perchoBuildCommit, release.sourceCommit, "Packaged application source");
	assert.equal(metadata.productName, channels[release.channel].name);
	for (const file of ["out/main/index.js", "out/preload/index.cjs", "out/renderer/index.html"])
		assert.ok(entries.includes(file), `Missing packaged ${file}`);
	assert.ok(
		entries.some((name) => /^out\/renderer\/assets\/.+\.js$/.test(name)),
		"Missing renderer assets",
	);
	assert.ok(!entries.some((name) => name.startsWith("node_modules/happy-dom/")), "Test dependency packaged");
	const actual = JSON.parse(await readFile(join(resources, "remote-runtime/manifest.json"), "utf8"));
	assert.deepEqual(actual, runtimeManifest, "Packaged runtime manifest");
	for (const file of ["vendor/marked-cjk-friendly.min.js", "template.html"])
		assert.ok((await stat(join(resources, "pi-package/dist/core/export-html", file))).size > 0);
	return {
		version: metadata.version,
		channel: metadata.releaseChannel,
		sourceCommit: metadata.perchoBuildCommit,
	};
}
