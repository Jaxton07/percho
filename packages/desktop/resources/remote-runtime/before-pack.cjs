const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
module.exports = async ({ packager }) => {
	const path = join(packager.info.appDir, "resources/remote-runtime/manifest.json");
	const manifest = JSON.parse(
		await readFile(path, "utf8").catch(() => {
			throw new Error(
				"Prepare verified Linux runtime artifacts and their desktop manifest before packaging (see docs/build-release.md)",
			);
		}),
	);
	const { releasePlan } = await import("../../../../scripts/release/plan.mjs");
	releasePlan(
		packager.appInfo.version,
		manifest.sourceCommit,
		packager.config.extraMetadata?.releaseChannel || "stable",
	);
	if (
		manifest.version !== 1 ||
		manifest.releaseId !== `v${packager.appInfo.version}` ||
		(packager.config.extraMetadata?.perchoBuildCommit &&
			manifest.sourceCommit !== packager.config.extraMetadata.perchoBuildCommit) ||
		!manifest.artifacts?.x64 ||
		!manifest.artifacts?.arm64
	)
		throw new Error("Runtime manifest does not match this desktop release");
};
