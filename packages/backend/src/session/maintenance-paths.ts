import { lstatSync, realpathSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import type { LocalSessionPaths } from "../storage/session-paths";

/** 维护只允许服务自身agent目录的会话；不改变普通远端open的路径语义。 */
export function maintenancePaths(
	root: string,
	mapped?: LocalSessionPaths,
): Pick<LocalSessionPaths, "resolveFile"> {
	return {
		resolveFile(file: string) {
			const approved = resolve(mapped ? mapped.resolveFile(file, true) : file),
				base = resolve(root);
			const parts = relative(base, approved).split(sep);
			const section = process.platform === "win32" ? parts[0]?.toLowerCase() : parts[0];
			if (
				!parts.length ||
				!["sessions", "sessions-subagents"].includes(section ?? "") ||
				parts.some((part) => part === "..") ||
				extname(approved).toLowerCase() !== ".jsonl"
			)
				throw new Error("Maintenance requires a managed session in this service's agent directory");
			let current = base;
			for (const part of parts) {
				current = join(current, part);
				const stat = lstatSync(current);
				if (stat.isSymbolicLink()) throw new Error("Maintenance refuses linked session paths");
			}
			const stat = lstatSync(approved);
			if (!stat.isFile()) throw new Error("Maintenance requires an existing regular session file");
			const actual = realpathSync(approved),
				actualRoot = realpathSync(base);
			if (!actual.startsWith(actualRoot + sep))
				throw new Error("Maintenance source escapes the private session root");
			return actual;
		},
	};
}
