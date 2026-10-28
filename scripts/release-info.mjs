import { appendFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { currentRelease } from "./release/plan.mjs";

const { values } = parseArgs({ options: { "ci-beta": { type: "boolean", default: false } } });
const baseline = values["ci-beta"] ? await currentRelease() : undefined;
// CI builds exercise the prerelease channel without creating a tag or a public release.
const version = baseline
	? `${baseline.version.split("-")[0]}-beta.${process.env.GITHUB_RUN_NUMBER || "0"}`
	: process.env.RELEASE_VERSION || undefined;
const release = await currentRelease({ version });
if (process.env.GITHUB_OUTPUT) {
	await appendFile(
		process.env.GITHUB_OUTPUT,
		Object.entries(release)
			.map(([key, value]) => `${key}=${value}\n`)
			.join(""),
	);
}
console.log(JSON.stringify(release));
