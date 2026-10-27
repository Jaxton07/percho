import { lstatSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { LocalStorageRecord } from "./local-storage";
import { inside } from "./path-policy";

export interface LocalSessionPaths {
	resolveFile(path: string, allowMissing?: boolean): string;
	assertCwd(cwd: string): void;
}
export function mappedStoragePath(file: string, record: LocalStorageRecord): string {
	if (record.kind !== "import") return file;
	const path = resolve(file);
	for (const source of record.sources)
		if (inside(source, path)) return join(record.target, relative(source, path));
	return file;
}
function realOrMissing(path: string): string {
	try {
		lstatSync(path);
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return join(realOrMissing(parent), relative(parent, path));
	}
}
/** Installed only in the desktop backend, never a global filesystem redirect or remote option. */
export function localSessionPaths(record: LocalStorageRecord, legacyRoots: string[]): LocalSessionPaths {
	const oldRoots = [...new Set([...legacyRoots, ...record.sources])];
	return {
		resolveFile(file, allowMissing = false) {
			const original = resolve(file),
				mapped = resolve(mappedStoragePath(original, record));
			const isOld = oldRoots.some((root) => inside(root, original));
			const part = relative(record.target, mapped).split(sep);
			const section = process.platform === "win32" ? (part[0] ?? "").toLowerCase() : (part[0] ?? "");
			const extension = process.platform === "win32" ? extname(mapped).toLowerCase() : extname(mapped);
			const managed = ["sessions", "sessions-subagents"].includes(section) && extension === ".jsonl";
			let result = mapped;
			if (isOld && (mapped === original || !managed))
				throw new Error(`Legacy session was not imported: ${file}`);
			if (inside(record.target, mapped)) {
				if (!managed) throw new Error(`Not a managed session file: ${file}`);
				const actual = realOrMissing(mapped),
					root = join(record.target, section);
				if (!inside(root, actual)) throw new Error(`Session escapes private storage: ${file}`);
				if (!allowMissing || isOld) {
					const stat = lstatSync(mapped);
					if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Session is not a file: ${file}`);
				}
				// Use real spelling to deduplicate case aliases, with the SDK's canonical readonly section.
				if (process.platform === "win32")
					result = join(record.target, section, ...relative(record.target, actual).split(sep).slice(1));
			} else if (oldRoots.some((root) => inside(root, realOrMissing(mapped))))
				throw new Error(`Session points to Pi storage: ${file}`);
			return result;
		},
		assertCwd(cwd) {
			const actual = realOrMissing(resolve(cwd));
			if (oldRoots.some((root) => inside(root, resolve(cwd)) || inside(root, actual)))
				throw new Error(`Project is inside legacy Pi storage; move the project before continuing: ${cwd}`);
		},
	};
}
