import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Resolve the worktree root without inheriting Git's repository overrides. */
export async function resolveChannelProject(cwd: string, boundRoot?: string): Promise<string> {
	const current = await realpath(cwd);
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
	env.LC_ALL = "C";
	let root: string | undefined;
	try {
		const result = await exec("git", ["rev-parse", "--show-toplevel"], {
			cwd: current,
			env,
			shell: false,
			timeout: 5000,
		});
		root = await realpath(result.stdout.trim());
	} catch (error) {
		// Only Git's explicit non-repository response permits a fallback.
		const failure = error as { code?: unknown; stderr?: unknown };
		if (
			failure.code !== 128 ||
			typeof failure.stderr !== "string" ||
			!/^fatal: not a git repository(?: \(or any of the parent directories\): \.git)?\s*$/i.test(
				failure.stderr,
			)
		)
			throw error;
	}
	if (root) return root;
	if (!boundRoot) return current;
	const bound = await realpath(boundRoot);
	const rel = relative(bound, current);
	if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
		throw new Error("Channel project root does not contain cwd");
	}
	return bound;
}
