import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { artifactNames } from "./plan.mjs";
import { sha256 } from "./run.mjs";
import { prepareRuntimeManifest } from "./runtime-manifest.mjs";

/** A release is complete only when every platform and both runtimes have passed. */
export async function verifyBundle(directory, release) {
	await prepareRuntimeManifest(directory, null, release);
	const files = [];
	const names = new Set();
	for (const [platform, architectures] of [
		["darwin", ["arm64", "x64"]],
		["win32", ["x64"]],
		["linux", ["x64"]],
	]) {
		const reportName = `release-${platform}.json`;
		const report = JSON.parse(await readFile(join(directory, reportName), "utf8"));
		for (const key of ["version", "tag", "channel", "prerelease", "sourceCommit"])
			assert.equal(report[key], release[key], `Release report ${key}`);
		assert.equal(report.platform, platform);
		assert.deepEqual(report.architectures, architectures);
		assert.ok(architectures.includes(report.startupArchitecture));
		assert.equal(report.mode, "release");
		assert.equal(report.passed, true);
		for (const name of artifactNames(release, platform, architectures))
			assert.ok(
				report.artifacts.some((item) => item.name === name),
				`Missing release asset ${name}`,
			);
		if (!release.prerelease) {
			const feed =
				platform === "darwin" ? "latest-mac.yml" : platform === "win32" ? "latest.yml" : "latest-linux.yml";
			assert.ok(
				report.artifacts.some((item) => item.name === feed),
				`Missing updater feed ${feed}`,
			);
		}
		for (const item of report.artifacts) {
			assert.equal(typeof item.name, "string");
			assert.ok(
				item.name === basename(item.name) && !/[\\/]/.test(item.name) && !names.has(item.name),
				"Unsafe or duplicate asset name",
			);
			assert.ok(/\.(dmg|zip|exe|AppImage|blockmap|yml)$/.test(item.name));
			names.add(item.name);
			const path = join(directory, item.name);
			assert.equal((await stat(path)).size, item.bytes, `Asset size ${item.name}`);
			assert.equal(await sha256(path), item.sha256, `Asset hash ${item.name}`);
			files.push(item.name);
		}
		const sums = report.artifacts.map((item) => `${item.sha256}  ${item.name}\n`).join("");
		const sumsName = `SHA256SUMS-${platform}.txt`;
		assert.equal(await readFile(join(directory, sumsName), "utf8"), sums);
		files.push(reportName, sumsName);
	}
	for (const arch of ["x64", "arm64"])
		files.push(`percho-runtime-linux-${arch}.tar.gz`, `runtime-linux-${arch}.json`);
	return files;
}
