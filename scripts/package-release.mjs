/** One local-platform build, verification and native startup smoke. Never publishes or installs. */

import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import channels from "../packages/desktop/build/app-channels.json" with { type: "json" };
import { retireMacApplication } from "./macos-app-cleanup.mjs";
import {
	appExecutable,
	artifactNames,
	builderTargetArguments,
	currentRelease,
	nativeApp,
	root,
} from "./release/plan.mjs";
import { run, sha256 } from "./release/run.mjs";
import { prepareRuntimeManifest } from "./release/runtime-manifest.mjs";
import { verifyApp } from "./release/verify-app.mjs";

const { values: args } = parseArgs({
	options: {
		version: { type: "string" },
		channel: { type: "string" },
		arch: { type: "string", default: process.arch },
		"runtime-dir": { type: "string", default: ".local/runtime-release" },
		output: { type: "string" },
		dir: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
	},
});
if (args.help) {
	console.log(
		"npm run package:beta -- --version X.Y.Z-beta.N --runtime-dir <verified-artifacts> [--arch arm64|x64|all] [--dir] [--output <new-directory>]",
	);
} else {
	const release = await currentRelease({ version: args.version, channel: args.channel });
	const platform = process.platform;
	if (!["darwin", "win32", "linux"].includes(platform)) throw new Error("Unsupported desktop platform");
	const architectures = args.arch === "all" && platform === "darwin" ? ["arm64", "x64"] : [args.arch];
	if (
		architectures.some((arch) => !["arm64", "x64"].includes(arch)) ||
		(platform !== "darwin" && args.arch !== "x64")
	)
		throw new Error("macOS supports arm64/x64/all; Windows and Linux desktop packaging require x64");
	if (!architectures.includes(process.arch))
		throw new Error("Include the native CPU architecture for startup verification");
	if (!process.env.npm_execpath)
		throw new Error("Run this command through npm run package:release or package:beta");
	const manifest = await prepareRuntimeManifest(
		resolve(root, args["runtime-dir"]),
		resolve(root, "packages/desktop/resources/remote-runtime/manifest.json"),
		release,
	);
	const output = resolve(
		root,
		args.output ?? `packages/desktop/dist/releases/${release.version}/${platform}`,
	);
	await mkdir(dirname(output), { recursive: true });
	await mkdir(output); // Never mix a previous or partial build with a new release.
	const buildOutput = platform === "darwin" ? join(output, "build.noindex") : output;
	let accepted = false;
	try {
		const env = {
			...process.env,
			PERCHO_BUILD_RELEASE_TAG: release.tag,
			PERCHO_BUILD_SOURCE_COMMIT: release.sourceCommit,
		};
		await run(process.execPath, [process.env.npm_execpath, "run", "build", "-w", "packages/desktop"], {
			cwd: root,
			env,
		});
		const require = createRequire(import.meta.url);
		const builder = join(dirname(require.resolve("electron-builder/package.json")), "cli.js");
		const config = release.prerelease ? "electron-builder.beta.cjs" : "electron-builder.yml";
		const configPath = join(output, "package-config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				extends: resolve(root, "packages/desktop", config),
				directories: { output: buildOutput },
				extraMetadata: {
					version: release.version,
					perchoBuildCommit: release.sourceCommit,
					productName: channels[release.channel].name,
				},
			}),
		);
		const builderArgs = [builder, "--config", configPath, "--publish", "never"];
		builderArgs.push(...builderTargetArguments(platform, architectures, args.dir));
		await run(process.execPath, builderArgs, { cwd: resolve(root, "packages/desktop"), env });
		for (const arch of architectures) {
			const app = nativeApp(buildOutput, platform, arch, channels[release.channel].name);
			await verifyApp(app, platform, release, manifest);
			if (platform === "darwin") await run("codesign", ["--verify", "--deep", "--strict", app]);
		}
		const app = nativeApp(buildOutput, platform, process.arch, channels[release.channel].name);
		await run(
			process.execPath,
			[
				resolve(root, "scripts/check-local-storage-startup.mjs"),
				"--app",
				appExecutable(app, platform, channels[release.channel].name, release.channel),
			],
			{ cwd: root, env },
		);
		const files = (await readdir(buildOutput, { withFileTypes: true }))
			.filter(
				(file) =>
					file.isFile() &&
					/\.(dmg|zip|exe|AppImage|blockmap|yml)$/.test(file.name) &&
					!file.name.startsWith("builder-"),
			)
			.map((file) => file.name);
		if (!args.dir)
			for (const expected of artifactNames(release, platform, architectures)) {
				if (!files.includes(expected)) throw new Error(`Missing release artifact: ${expected}`);
			}
		if (platform === "darwin")
			for (const file of files.filter((file) => file.endsWith(".dmg")))
				await run("hdiutil", ["verify", join(buildOutput, file)]);
		const artifacts = [];
		for (const name of files) {
			const path = join(buildOutput, name);
			artifacts.push({ name, bytes: (await stat(path)).size, sha256: await sha256(path) });
		}
		const destination = join(output, "artifacts");
		await mkdir(destination);
		for (const file of files) await rename(join(buildOutput, file), join(destination, file));
		const report = {
			...release,
			platform,
			architectures,
			mode: args.dir ? "unpacked" : "release",
			startupArchitecture: process.arch,
			passed: true,
			artifacts,
		};
		await writeFile(join(destination, `release-${platform}.json`), `${JSON.stringify(report, null, 2)}\n`);
		await writeFile(
			join(destination, `SHA256SUMS-${platform}.txt`),
			artifacts.map((item) => `${item.sha256}  ${item.name}\n`).join(""),
		);
		console.log(JSON.stringify({ verified: true, ...release, artifacts: destination }));
		accepted = true;
	} finally {
		if (platform === "darwin")
			for (const arch of architectures) {
				await retireMacApplication(nativeApp(buildOutput, platform, arch, channels[release.channel].name), {
					remove: accepted && !args.dir,
				});
			}
		if (platform === "darwin" && accepted && !args.dir)
			await rm(buildOutput, { recursive: true, force: true });
	}
}
