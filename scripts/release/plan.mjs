import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Deliberately support only the release formats we distribute: stable, beta.N and rc.N. */
export function releasePlan(version, sourceCommit, requiredChannel) {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta|rc)\.(0|[1-9]\d*))?$/.exec(version);
	if (!match) throw new Error("Use X.Y.Z, X.Y.Z-beta.N or X.Y.Z-rc.N as the release version");
	if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("A full source commit is required");
	const channel = match[4] ? "beta" : "stable";
	if (requiredChannel && requiredChannel !== channel)
		throw new Error(`${requiredChannel} packaging requires a ${requiredChannel} version`);
	return { version, tag: `v${version}`, channel, prerelease: channel === "beta", sourceCommit };
}

export async function currentRelease({ version, channel } = {}) {
	const desktop = JSON.parse(await readFile(resolve(root, "packages/desktop/package.json"), "utf8"));
	const tag = process.env.PERCHO_BUILD_RELEASE_TAG || undefined;
	if (tag && !tag.startsWith("v")) throw new Error("Release tags must start with v");
	if (version && tag && tag !== `v${version}`) throw new Error("Version and release tag disagree");
	const commit = execFileSync("git", ["-c", `safe.directory=${root}`, "rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	if (process.env.PERCHO_BUILD_SOURCE_COMMIT && process.env.PERCHO_BUILD_SOURCE_COMMIT !== commit)
		throw new Error("Release source commit does not match the checkout");
	return releasePlan(version ?? tag?.slice(1) ?? desktop.version, commit, channel);
}

export function nativeApp(output, platform, arch, productName) {
	if (platform === "darwin")
		return resolve(output, arch === "arm64" ? "mac-arm64" : "mac", `${productName}.app`);
	if (platform === "win32") return resolve(output, "win-unpacked");
	if (platform === "linux") return resolve(output, "linux-unpacked");
	throw new Error(`Unsupported packaging platform: ${platform}`);
}

export function appExecutable(app, platform, productName, channel) {
	if (platform === "darwin") return resolve(app, "Contents/MacOS", productName);
	if (platform === "win32") return resolve(app, `${productName}.exe`);
	return resolve(app, channel === "beta" ? "percho-beta" : "percho");
}

export function artifactNames(release, platform, architectures) {
	const prefix = release.prerelease ? `percho-beta-${release.version}` : "percho";
	if (platform === "darwin")
		return architectures.flatMap((arch) => [`${prefix}-mac-${arch}.dmg`, `${prefix}-mac-${arch}.zip`]);
	if (platform === "win32") return [`${prefix}-windows-x64.exe`, `${prefix}-windows-x64.zip`];
	return [`${prefix}-linux-x86_64.AppImage`];
}

export function builderTargetArguments(platform, architectures, unpacked) {
	const targets =
		platform === "darwin"
			? ["--mac", "dmg", "zip"]
			: platform === "win32"
				? ["--win", "nsis", "zip"]
				: ["--linux", "AppImage"];
	// Nonempty CLI targets override inherited target architectures; --arm64 alone does not.
	return [...(unpacked ? ["--dir"] : targets), ...architectures.map((arch) => `--${arch}`)];
}
