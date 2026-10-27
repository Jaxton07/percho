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
	if (
		manifest.version !== 1 ||
		manifest.releaseId !== `v${packager.appInfo.version}` ||
		!manifest.artifacts?.x64 ||
		!manifest.artifacts?.arm64
	)
		throw new Error("Runtime manifest does not match this desktop release");
};
