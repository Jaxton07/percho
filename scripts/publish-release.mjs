/** CI-only final step: validate all assets, upload to a draft, then expose one complete release. */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { verifyBundle } from "./release/bundle.mjs";
import { currentRelease } from "./release/plan.mjs";
import { run, sha256 } from "./release/run.mjs";

const release = await currentRelease();
const directory = resolve(process.argv[2] || ".local/release-bundle");
const files = await verifyBundle(directory, release);
if (process.argv[3] !== "--publish") {
	console.log(JSON.stringify({ verified: true, ...release, files }));
} else {
	if (!process.env.GH_REPO || !/^[\w.-]+\/[\w.-]+$/.test(process.env.GH_REPO))
		throw new Error("GH_REPO is required");
	const exec = promisify(execFile);
	if ((await exec("git", ["status", "--porcelain"])).stdout.trim())
		throw new Error("Publish only from a clean checkout of the recorded source commit");
	// Listing authenticated releases includes drafts even before their tag exists.
	const readRelease = async () => {
		const pages = JSON.parse(
			(
				await exec(
					"gh",
					["api", "--paginate", "--slurp", `repos/${process.env.GH_REPO}/releases?per_page=100`],
					{ maxBuffer: 32 * 1024 * 1024 },
				)
			).stdout,
		);
		const matching = pages.flat().filter((item) => item.tag_name === release.tag);
		if (matching.length > 1) throw new Error("Multiple releases have the requested tag");
		return matching[0];
	};
	try {
		const reference = JSON.parse(
			(await exec("gh", ["api", `repos/${process.env.GH_REPO}/git/ref/tags/${release.tag}`])).stdout,
		);
		let target = reference.object;
		while (target.type === "tag") {
			target = JSON.parse(
				(await exec("gh", ["api", `repos/${process.env.GH_REPO}/git/tags/${target.sha}`])).stdout,
			).object;
		}
		if (target.type !== "commit" || target.sha !== release.sourceCommit)
			throw new Error("Release tag points to a different source commit");
	} catch (error) {
		if (!error.stderr?.includes("HTTP 404")) throw error;
	}
	const existing = await readRelease();
	if (existing && (!existing.draft || existing.target_commitish !== release.sourceCommit))
		throw new Error("Refusing to modify a public release or a draft from another source commit");
	const repo = ["--repo", process.env.GH_REPO];
	if (!existing)
		await run("gh", [
			"release",
			"create",
			release.tag,
			...repo,
			"--draft",
			"--target",
			release.sourceCommit,
			"--title",
			release.tag,
			"--notes",
			`Version ${release.version}\nSource: ${release.sourceCommit}\n\nDesktop packages and Linux SSH runtimes were verified together. macOS packages use ad-hoc signing and are not notarized. Beta keeps separate application data and is installed manually.`,
			...(release.prerelease ? ["--prerelease"] : []),
		]);
	await run("gh", [
		"release",
		"upload",
		release.tag,
		...repo,
		...files.map((file) => join(directory, file)),
		"--clobber",
	]);
	const uploaded = await readRelease();
	if (!uploaded?.draft || uploaded.target_commitish !== release.sourceCommit)
		throw new Error("Draft state changed during upload");
	for (const file of files) {
		const asset = uploaded.assets.find((item) => item.name === file);
		if (!asset || asset.size !== (await stat(join(directory, file))).size)
			throw new Error(`Incomplete draft upload: ${file}`);
		if (asset.digest && asset.digest !== `sha256:${await sha256(join(directory, file))}`)
			throw new Error(`Uploaded asset digest mismatch: ${file}`);
	}
	await run("gh", [
		"release",
		"edit",
		release.tag,
		...repo,
		"--draft=false",
		`--prerelease=${release.prerelease}`,
		`--latest=${!release.prerelease}`,
	]);
}
