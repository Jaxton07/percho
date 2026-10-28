/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: electron-builder expands these placeholders. */
const { beta } = require("./build/app-channels.json");

module.exports = {
	extends: "./electron-builder.yml",
	appId: beta.appId,
	productName: beta.name,
	icon: "build/icon-beta.png",
	extraMetadata: { releaseChannel: "beta", productName: beta.name },
	directories: { output: "dist/beta.noindex" },
	artifactName: "percho-beta-${version}-${os}-${arch}.${ext}",
	mac: { artifactName: "percho-beta-${version}-mac-${arch}.${ext}" },
	win: { artifactName: "percho-beta-${version}-windows-${arch}.${ext}" },
	linux: { artifactName: "percho-beta-${version}-linux-${arch}.${ext}", executableName: "percho-beta" },
	publish: null,
};
