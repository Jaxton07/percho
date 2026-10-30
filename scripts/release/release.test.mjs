import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createPackage } from "@electron/asar";
import nodePolicy from "../../packages/shared/src/runtime-node-policy.json" with { type: "json" };
import { verifyBundle } from "./bundle.mjs";
import { artifactNames, builderTargetArguments, releasePlan, root } from "./plan.mjs";
import { run } from "./run.mjs";
import { prepareRuntimeManifest } from "./runtime-manifest.mjs";
import { verifyApp } from "./verify-app.mjs";

const release = releasePlan("0.6.6-beta.1", "a".repeat(40));
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
	const parent = join(root, ".local/tmp/release-tests");
	await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(join(parent, "case-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}
async function json(path, value) {
	await writeFile(path, JSON.stringify(value));
}
async function runtimes(directory, plan = release) {
	for (const arch of ["x64", "arm64"]) {
		const asset = `percho-runtime-linux-${arch}.tar.gz`;
		const bytes = Buffer.from(`test fixture ${arch}`);
		await writeFile(join(directory, asset), bytes);
		await json(join(directory, `runtime-linux-${arch}.json`), {
			version: 1,
			releaseId: plan.tag,
			runtimeVersion: plan.version,
			sourceCommit: plan.sourceCommit,
			arch,
			asset,
			protocol: 3,
			sdkVersion: "1.4.0",
			minimumGlibc: "2.35",
			node: nodePolicy.node,
			bytes: bytes.length,
			sha256: hash(bytes),
			url: `https://github.com/Jaxton07/percho/releases/download/${plan.tag}/${asset}`,
		});
	}
}
async function bundle(directory, plan = release) {
	await runtimes(directory, plan);
	for (const [platform, architectures] of [
		["darwin", ["arm64", "x64"]],
		["win32", ["x64"]],
		["linux", ["x64"]],
	]) {
		const artifacts = [];
		const names = artifactNames(plan, platform, architectures);
		if (!plan.prerelease)
			names.push(
				platform === "darwin" ? "latest-mac.yml" : platform === "win32" ? "latest.yml" : "latest-linux.yml",
			);
		for (const name of names) {
			const bytes = Buffer.from(name);
			await writeFile(join(directory, name), bytes);
			artifacts.push({ name, bytes: bytes.length, sha256: hash(bytes) });
		}
		await json(join(directory, `release-${platform}.json`), {
			...plan,
			platform,
			architectures,
			mode: "release",
			startupArchitecture: architectures[0],
			passed: true,
			artifacts,
		});
		await writeFile(
			join(directory, `SHA256SUMS-${platform}.txt`),
			artifacts.map((item) => `${item.sha256}  ${item.name}\n`).join(""),
		);
	}
}

test("Beta requires an explicit prerelease; version metadata cannot masquerade as stable", () => {
	assert.equal(release.channel, "beta");
	assert.equal(releasePlan("1.0.0-rc.2", release.sourceCommit).prerelease, true);
	assert.equal(releasePlan("1.0.0", release.sourceCommit).channel, "stable");
	for (const version of ["v1.0.0", "1.0", "01.0.0", "1.0.0-beta", "1.0.0-beta.01", "1.0.0+local", "../bad"])
		assert.throws(() => releasePlan(version, release.sourceCommit));
	assert.throws(() => releasePlan("1.0.0", release.sourceCommit, "beta"));
	assert.throws(() => releasePlan("1.0.0", "bad"));
});

test("CI release metadata uses an explicit Beta version and records checkout source", async (t) => {
	const directory = await fixture(t);
	const output = join(directory, "outputs");
	const exec = promisify(execFile);
	const result = await exec(process.execPath, [join(root, "scripts/release-info.mjs"), "--ci-beta"], {
		env: {
			...process.env,
			PERCHO_BUILD_RELEASE_TAG: "",
			PERCHO_BUILD_SOURCE_COMMIT: "",
			GITHUB_RUN_NUMBER: "123",
			GITHUB_OUTPUT: output,
		},
	});
	const metadata = JSON.parse(result.stdout);
	assert.match(metadata.version, /^\d+\.\d+\.\d+-beta\.123$/);
	assert.equal(metadata.channel, "beta");
	assert.equal(metadata.prerelease, true);
	assert.match(metadata.sourceCommit, /^[a-f0-9]{40}$/);
	assert.ok((await readFile(output, "utf8")).includes(`tag=v${metadata.version}\n`));
});

test("builder receives explicit targets so inherited macOS x64 targets cannot expand an arm64 build", () => {
	const require = createRequire(join(root, "packages/desktop/package.json"));
	const { createYargs, configureBuildCommand, normalizeOptions } = require("electron-builder/out/builder.js");
	const { Platform, Arch } = require("electron-builder");
	for (const architectures of [["arm64"], ["arm64", "x64"]]) {
		const parsed = configureBuildCommand(createYargs()).parseSync(
			builderTargetArguments("darwin", architectures, false),
		);
		const targets = normalizeOptions(parsed).targets.get(Platform.MAC);
		assert.deepEqual([...targets.keys()].sort(), architectures.map((arch) => Arch[arch]).sort());
		for (const types of targets.values()) assert.deepEqual(types, ["dmg", "zip"]);
	}
});
test("runtime manifest requires both architectures, exact version/source and intact bytes", async (t) => {
	const directory = await fixture(t);
	await runtimes(directory);
	const output = join(directory, "manifest.json");
	const manifest = await prepareRuntimeManifest(directory, output, release);
	assert.equal(manifest.runtimeVersion, release.version);
	assert.equal(manifest.sourceCommit, release.sourceCommit);
	assert.deepEqual(Object.keys(manifest.artifacts), ["x64", "arm64"]);
	for (const wrong of [
		{ ...release, sourceCommit: "b".repeat(40) },
		releasePlan("0.6.6-beta.2", release.sourceCommit),
	])
		await assert.rejects(prepareRuntimeManifest(directory, output, wrong), /metadata/);
	await writeFile(join(directory, "percho-runtime-linux-arm64.tar.gz"), "damaged");
	await assert.rejects(prepareRuntimeManifest(directory, output, release), /integrity/);
	assert.deepEqual(
		JSON.parse(await readFile(output, "utf8")),
		manifest,
		"Failed validation leaves previous manifest intact",
	);
});
test("complete Beta and stable bundles validate; incomplete/tampered bundles are blocked", async (t) => {
	const directory = await fixture(t);
	await bundle(directory);
	assert.ok((await verifyBundle(directory, release)).includes("percho-beta-0.6.6-beta.1-mac-x64.dmg"));
	await rm(join(directory, "release-win32.json"));
	await assert.rejects(verifyBundle(directory, release));
	await bundle(directory);
	await writeFile(join(directory, artifactNames(release, "linux", ["x64"])[0]), "damaged");
	await assert.rejects(verifyBundle(directory, release));
	const stable = releasePlan("0.6.6", release.sourceCommit);
	await bundle(directory, stable);
	assert.ok((await verifyBundle(directory, stable)).includes("latest-mac.yml"));
	await rm(join(directory, "latest.yml"));
	await assert.rejects(verifyBundle(directory, stable));
});
test("failed, wrong-source and unpacked reports cannot be published; paths cannot escape bundle", async (t) => {
	const directory = await fixture(t);
	await bundle(directory);
	const path = join(directory, "release-darwin.json");
	const report = JSON.parse(await readFile(path, "utf8"));
	for (const change of [
		{ passed: false },
		{ mode: "unpacked" },
		{ sourceCommit: "b".repeat(40) },
		{ architectures: ["arm64"] },
		{ artifacts: [...report.artifacts, { name: "../escape.zip" }] },
	]) {
		await json(path, { ...report, ...change });
		await assert.rejects(verifyBundle(directory, release));
	}
});
test("actual asar metadata and external resources are verified", async (t) => {
	const directory = await fixture(t);
	const source = join(directory, "source");
	const resources = join(directory, "app/resources");
	for (const path of [
		source,
		resources,
		join(resources, "remote-runtime"),
		join(resources, "pi-package/dist/core/export-html/vendor"),
	])
		await mkdir(path, { recursive: true });
	for (const file of [
		"out/main/index.js",
		"out/preload/index.cjs",
		"out/renderer/index.html",
		"out/renderer/assets/app.js",
	]) {
		await mkdir(join(source, file, ".."), { recursive: true });
		await writeFile(join(source, file), "fixture");
	}
	await json(join(source, "package.json"), {
		version: release.version,
		releaseChannel: "beta",
		productName: "Percho Beta",
		perchoBuildCommit: release.sourceCommit,
	});
	await createPackage(source, join(resources, "app.asar"));
	await json(join(resources, "remote-runtime/manifest.json"), { fixture: true });
	for (const file of ["template.html", "vendor/marked-cjk-friendly.min.js"])
		await writeFile(join(resources, "pi-package/dist/core/export-html", file), "fixture");
	await verifyApp(join(directory, "app"), "linux", release, { fixture: true });
	await assert.rejects(
		verifyApp(join(directory, "app"), "linux", { ...release, version: "0.6.6" }, { fixture: true }),
		/version/,
	);
	await rm(join(resources, "pi-package/dist/core/export-html/template.html"));
	await assert.rejects(verifyApp(join(directory, "app"), "linux", release, { fixture: true }));
});
test("a failed subprocess stops the pipeline", async () => {
	await assert.rejects(run(process.execPath, ["-e", "process.exit(9)"]), /exited with 9/);
});

test("builder hook also blocks raw Beta builds carrying a stable version", async (t) => {
	const directory = await fixture(t);
	await runtimes(directory);
	const output = join(directory, "resources/remote-runtime/manifest.json");
	await prepareRuntimeManifest(directory, output, release);
	const hook = createRequire(import.meta.url)(
		"../../packages/desktop/resources/remote-runtime/before-pack.cjs",
	);
	const packager = {
		info: { appDir: directory },
		appInfo: { version: release.version },
		config: { extraMetadata: { releaseChannel: "beta", perchoBuildCommit: release.sourceCommit } },
	};
	await hook({ packager });
	packager.appInfo.version = "0.6.6";
	await assert.rejects(hook({ packager }), /beta version/);
});

test("publisher uploads to a draft, verifies every asset, then publishes; public releases and incomplete uploads stay untouched", {
	skip: process.platform === "win32",
}, async (t) => {
	const directory = await fixture(t);
	await bundle(directory);
	const files = await verifyBundle(directory, release);
	const assets = await Promise.all(
		files.map(async (name) => ({ name, size: (await stat(join(directory, name))).size })),
	);
	const bin = join(directory, "bin");
	await mkdir(bin);
	// Fake CLI executables keep this integration test entirely offline and record every mutation.
	const cli = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const args = process.argv.slice(2);
if (basename(process.argv[1]) === "git") {
	if (args.includes("rev-parse")) console.log("${release.sourceCommit}");
} else {
	const statePath = process.env.MOCK_STATE;
	const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath)) : {};
	appendFileSync(process.env.MOCK_CALLS, JSON.stringify(args) + "\\n");
	if (args[0] === "api") {
		if (args.at(-1).includes("/git/ref/")) { console.error("HTTP 404"); process.exit(1); }
		const active = process.env.MOCK_MODE === "public" || state.created;
		console.log(JSON.stringify([active ? [{ tag_name: "${release.tag}", draft: process.env.MOCK_MODE !== "public", target_commitish: "${release.sourceCommit}", assets: state.uploaded && process.env.MOCK_MODE !== "incomplete" ? ${JSON.stringify(assets)} : [] }] : []]));
	} else {
		if (args[1] === "create") state.created = true;
		if (args[1] === "upload") state.uploaded = true;
		writeFileSync(statePath, JSON.stringify(state));
	}
}
`;
	for (const name of ["git", "gh"]) {
		await writeFile(join(bin, name), cli);
		await chmod(join(bin, name), 0o700);
	}
	for (const mode of ["public", "incomplete", "success"]) {
		const calls = join(directory, `calls-${mode}.jsonl`);
		const exec = promisify(execFile);
		const operation = exec(
			process.execPath,
			[join(root, "scripts/publish-release.mjs"), directory, "--publish"],
			{
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					GH_REPO: "test/repo",
					MOCK_MODE: mode,
					MOCK_STATE: join(directory, `state-${mode}.json`),
					MOCK_CALLS: calls,
					PERCHO_BUILD_RELEASE_TAG: release.tag,
					PERCHO_BUILD_SOURCE_COMMIT: release.sourceCommit,
				},
			},
		);
		if (mode === "success") await operation;
		else await assert.rejects(operation, mode === "public" ? /public release/ : /Incomplete draft/);
		const commands = (await readFile(calls, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const mutations = commands.filter((args) => args[0] === "release");
		assert.deepEqual(
			mutations.map((args) => args[1]),
			mode === "public" ? [] : mode === "incomplete" ? ["create", "upload"] : ["create", "upload", "edit"],
		);
		if (mode === "success") {
			assert.ok(mutations[0].includes("--draft"));
			assert.ok(mutations[2].includes("--latest=false"));
			assert.ok(mutations[2].includes("--prerelease=true"));
		}
	}
});
