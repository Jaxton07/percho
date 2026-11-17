import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateNoSymlinks } from "./paths.mjs";

const entries = async (path) => {
	try {
		return await readdir(path);
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
};
/** Archive collector checkpoints even when a suite never returns a successful result. */
export async function archiveSuiteArtifacts({ runDir, suite }) {
	const raw = join(runDir, "raw");
	validateNoSymlinks(raw);
	const copy = async (source, name) => {
		validateNoSymlinks(source);
		let info;
		try {
			info = await lstat(source);
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		if (!info.isFile()) throw new Error("Expected ordinary checkpoint file");
		const target = join(raw, name);
		validateNoSymlinks(target);
		try {
			await writeFile(target, await readFile(source), { flag: "wx", mode: 0o600 });
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
	};
	if (suite === "minimap") {
		const root = join(runDir, "work/minimap");
		validateNoSymlinks(root);
		for (const name of await entries(root))
			if (/^launch-\d+$/.test(name)) {
				await copy(join(root, name, "minimap-results.json"), `minimap-${name.slice(7)}.json`);
				await copy(join(root, name, "minimap-checkpoint.json"), `minimap-${name.slice(7)}-checkpoint.json`);
			}
	} else if (suite === "rendering") {
		for (const label of ["performance", "interactions", "smoke"]) {
			const root = join(runDir, "work/rendering", label);
			await copy(join(root, `${label}-checkpoint.json`), `rendering-${label}-checkpoint.json`);
			await copy(join(root, `${label}.json`), `rendering-${label}.json`);
		}
	} else if (suite === "images") await copy(join(runDir, "work/switch/ticket03-images.json"), "images.json");
	const prefix = suite === "large-text" ? "large-text" : suite;
	const files = [];
	for (const name of await entries(raw))
		if (name.startsWith(prefix) && name.endsWith(".json")) {
			const path = join(raw, name);
			validateNoSymlinks(path);
			if (!(await lstat(path)).isFile()) throw new Error("Expected ordinary raw artifact");
			files.push(`raw/${name}`);
		}
	return files.sort();
}
