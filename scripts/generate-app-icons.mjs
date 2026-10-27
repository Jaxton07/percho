import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const build = join(root, "packages/desktop/build");
const channels = JSON.parse(await readFile(join(build, "app-channels.json"), "utf8"));
const source = await readFile(join(build, "icon.svg"), "utf8");
for (const channel of ["beta", "dev"]) {
	const { badge, badgeColor } = channels[channel];
	const svg = source.replace(
		"</svg>",
		`<rect x="612" y="800" width="300" height="112" rx="38" fill="${badgeColor}"/>
<text x="762" y="876" text-anchor="middle" font-family="Arial, sans-serif" font-size="64" font-weight="700" letter-spacing="2" fill="#fff">${badge}</text>
</svg>`,
	);
	await writeFile(join(build, `icon-${channel}.svg`), svg);
}
const require = createRequire(import.meta.url);
const result = spawnSync(require("electron"), [join(root, "scripts/render-app-icons.cjs")], {
	stdio: "inherit",
	env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
});
process.exit(result.status ?? 1);
