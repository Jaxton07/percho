import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

// Check every existing ancestor, including when the leaf does not exist yet.
export function validateNoSymlinks(path) {
	if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Expected an absolute canonical path");
	let current = parse(path).root;
	for (const part of path.slice(current.length).split(sep)) {
		current = join(current, part);
		try {
			if (lstatSync(current).isSymbolicLink()) throw new Error("Symlink in performance path");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	return path;
}

export function validateRunPath(repo, run) {
	if (!isAbsolute(run) || resolve(run) !== run) throw new Error("Invalid performance run directory");
	const base = join(resolve(repo), ".local/test/performance");
	const name = relative(base, run);
	if (!name || name === ".." || name.includes(sep) || name === ".")
		throw new Error("Invalid performance run directory");
	return validateNoSymlinks(run);
}

export function validateRunOwner(repo, run, owner) {
	validateRunPath(repo, run);
	const marker = join(run, "owner.json");
	validateNoSymlinks(marker);
	if (realpathSync(marker) !== marker) throw new Error("Invalid performance owner marker");
	const data = JSON.parse(readFileSync(marker, "utf8"));
	if (!owner || data?.version !== 1 || data.kind !== "percho-performance-run" || data.owner !== owner)
		throw new Error("Performance owner mismatch");
}

export function validateWorkPath(repo, path) {
	if (!isAbsolute(path) || resolve(path) !== path)
		throw new Error("Expected an absolute canonical work path");
	const base = join(resolve(repo), ".local/test/performance");
	const parts = relative(base, path).split(sep);
	if (parts.length < 2 || !parts[0] || parts[0] === "." || parts[0] === ".." || parts[1] !== "work")
		throw new Error("Path must be inside a performance run work directory");
	return validateNoSymlinks(path);
}

export function suiteRoot(repo, name, legacy, envName) {
	const run = process.env.PERCHO_PERF_RUN_DIR;
	const explicit = process.env[envName];
	if (!run && !explicit) return resolve(repo, legacy);
	if (!run) throw new Error("PERCHO_PERF_RUN_DIR is required for a custom performance root");
	validateRunOwner(repo, run, process.env.PERCHO_PERF_OWNER);
	const expected = validateWorkPath(repo, join(resolve(run), "work", name));
	if (explicit) {
		const selected = validateWorkPath(repo, explicit);
		if (selected !== expected && !(name === "rendering" && selected.startsWith(`${expected}${sep}`)))
			throw new Error("Performance root does not match run");
		return selected;
	}
	return expected;
}
