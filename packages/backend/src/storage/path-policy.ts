import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

export const LOCAL_STORAGE_RECORD = ".percho-local-storage.json";
export function inside(root: string, file: string, platform = process.platform): boolean {
	const path = platform === "win32" ? win32 : { resolve, relative, sep, isAbsolute };
	const part = path.relative(path.resolve(root), path.resolve(file));
	return part === "" || (part !== ".." && !part.startsWith(`..${path.sep}`) && !path.isAbsolute(part));
}
export async function statOrMissing(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
/** Resolve existing ancestors without creating any directories. */
export async function canonicalPath(path: string): Promise<string> {
	if (await statOrMissing(path)) return realpath(path);
	const parent = dirname(path);
	if (parent === path) throw new Error(`Cannot resolve storage path: ${path}`);
	return join(await canonicalPath(parent), relative(parent, path));
}
export interface LocalStorageSelection {
	home: string;
	target: string;
	source: string | null;
	legacyRoots: string[];
	custom: boolean;
}
export function selectLocalStorage(
	home: string,
	packaged: boolean,
	env: NodeJS.ProcessEnv,
	beta = false,
): LocalStorageSelection {
	const value = env.PERCHO_AGENT_DIR;
	if (value === undefined && env.PI_CODING_AGENT_DIR !== undefined)
		throw new Error(
			"PERCHO_LEGACY_AGENT_ENV: Use PERCHO_AGENT_DIR or remove PI_CODING_AGENT_DIR before starting Percho.",
		);
	let target = join(home, ".percho", packaged ? (beta ? "agent-beta" : "agent") : "agent-dev");
	if (value !== undefined) {
		if (!value.trim()) throw new Error("PERCHO_AGENT_DIR must be an absolute, non-empty directory");
		target =
			value === "~"
				? home
				: value.startsWith("~/") || value.startsWith("~\\")
					? join(home, value.slice(2))
					: value;
		if (!isAbsolute(target)) throw new Error("PERCHO_AGENT_DIR must be absolute");
	}
	const legacyRoots = [join(home, ".pi", "agent"), join(home, ".pi", "agent-dev")];
	return {
		home,
		target: resolve(target),
		source: value === undefined && !beta ? (legacyRoots[packaged ? 0 : 1] as string) : null,
		legacyRoots,
		custom: value !== undefined,
	};
}
export async function validateStorageSelection(
	selection: LocalStorageSelection,
): Promise<LocalStorageSelection> {
	const target = await canonicalPath(selection.target);
	const legacyRoots = [
		...new Set((await Promise.all(selection.legacyRoots.map(canonicalPath))).concat(selection.legacyRoots)),
	];
	for (const legacy of legacyRoots)
		if (inside(legacy, target) || inside(target, legacy))
			throw new Error(`Storage overlaps Pi data: ${selection.target}`);
	const stat = await statOrMissing(selection.target);
	if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
		throw new Error(`Storage must be a real directory: ${selection.target}`);
	return { ...selection, target, legacyRoots };
}
export async function assertDesktopStorage(agent: string): Promise<void> {
	if (await statOrMissing(join(agent, "environment.json")))
		throw new Error(
			`PERCHO_REMOTE_STORAGE: ${agent} belongs to a remote runtime; choose another PERCHO_AGENT_DIR.`,
		);
}
export async function assertRemoteStorage(agent: string): Promise<void> {
	if (await statOrMissing(join(agent, LOCAL_STORAGE_RECORD)))
		throw new Error(`PERCHO_LOCAL_STORAGE: ${agent} belongs to the desktop; choose another runtime root.`);
}
