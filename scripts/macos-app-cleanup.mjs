import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const registrar =
	"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

async function unregisterBundle(bundle) {
	if (process.platform === "darwin") await exec(registrar, ["-u", bundle]);
}

/** Only pass a generated bundle owned by this build/dev invocation, never an installed application. */
export async function retireMacApplication(bundle, { remove = false, unregister = unregisterBundle } = {}) {
	if (!isAbsolute(bundle) || !bundle.endsWith(".app"))
		throw new Error("Expected an absolute generated .app path");
	const frameworks = join(bundle, "Contents/Frameworks");
	const children = await readdir(frameworks, { withFileTypes: true }).catch((error) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const applications = children
		.filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
		.map((entry) => join(frameworks, entry.name));
	// Remove before unregistering so discovery cannot register the on-disk copy again.
	if (remove) await rm(bundle, { recursive: true, force: true });
	for (const path of [...applications, bundle]) {
		try {
			await unregister(path);
		} catch (error) {
			// kLSApplicationNotFoundErr: helpers that were never registered are already clean.
			if (/:\s*-10814\b/.test(`${error.stdout ?? ""}\n${error.stderr ?? ""}`)) continue;
			console.warn(`Could not unregister temporary application ${path}: ${error.message}`);
		}
	}
}
