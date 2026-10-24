import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/** User-entered project directories are literal paths, never Markdown/URL/shell expressions. */
export async function validateProjectDirectory(path: string): Promise<string> {
	if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
		throw new Error("Enter an absolute project directory");
	const canonical = await realpath(path);
	if (!(await stat(canonical)).isDirectory()) throw new Error("Project path must be a directory");
	await access(canonical, constants.R_OK | constants.X_OK);
	return canonical;
}

/** Check selected file references at send time; this never reads their contents or substitutes local files. */
export async function validateProjectReference(path: string, cwd: string): Promise<void> {
	const target = resolve(cwd, path);
	const info = await stat(target);
	await access(target, constants.R_OK | (info.isDirectory() ? constants.X_OK : 0));
}
