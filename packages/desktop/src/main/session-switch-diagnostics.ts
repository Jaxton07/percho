import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { beginSessionSwitchProbe, finishSessionSwitchProbe } from "@percho/backend";
import type { SessionSwitchFixture } from "@percho/shared";
import { app } from "electron";

async function assertIsolated(): Promise<string> {
	const root = process.env.PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT;
	if (!root || !isAbsolute(root) || resolve(root) !== root)
		throw new Error("Session diagnostics require an explicitly isolated test instance");
	const legacy =
		!process.env.PERCHO_PERF_RUN_DIR &&
		root.endsWith(`${sep}.local${sep}tmp${sep}session-switch-diagnostics`);
	if (!legacy) {
		// Built diagnostic hosts live outside the source tree; never infer the repo from import.meta.url.
		const repo = process.env.PERCHO_PERF_SOURCE ?? resolve(process.cwd(), "../..");
		const run = process.env.PERCHO_PERF_RUN_DIR;
		const owner = process.env.PERCHO_PERF_OWNER;
		if (
			!isAbsolute(repo) ||
			resolve(repo) !== repo ||
			(await realpath(repo)) !== repo ||
			!run ||
			!isAbsolute(run) ||
			resolve(run) !== run ||
			(await realpath(run)) !== run
		)
			throw new Error("Session diagnostics require an explicitly isolated test instance");
		const parts = relative(join(repo, ".local/test/performance"), run).split(sep);
		if (parts.length !== 1 || !parts[0] || parts[0] === ".." || root !== join(run, "work", "switch"))
			throw new Error("Session diagnostics require an explicitly isolated test instance");
		const marker = join(run, "owner.json");
		if ((await lstat(marker)).isSymbolicLink() || (await realpath(marker)) !== marker)
			throw new Error("Invalid performance owner marker");
		const data = JSON.parse(await readFile(marker, "utf8"));
		if (!owner || data?.version !== 1 || data.kind !== "percho-performance-run" || data.owner !== owner)
			throw new Error("Performance owner mismatch");
	}
	const canonical = await realpath(root);
	if (
		canonical !== resolve(root) ||
		(await realpath(process.env.PI_CODING_AGENT_DIR ?? "")) !== join(canonical, "agent") ||
		!["user-data", "user-data-dev", "user-data-beta"].some(
			(name) => resolve(app.getPath("userData")) === join(canonical, name),
		) ||
		(await realpath(app.getPath("userData"))) !== resolve(app.getPath("userData"))
	) {
		throw new Error("Session diagnostics agent/userData isolation mismatch");
	}
	return canonical;
}
export async function getSessionSwitchFixtures(): Promise<SessionSwitchFixture[]> {
	const root = await assertIsolated();
	const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as SessionSwitchFixture[];
	if (!Array.isArray(manifest) || manifest.length !== 5)
		throw new Error("Invalid synthetic fixture manifest");
	const names = ["screenshots", "text", "long-text", "large-turn", "branches"];
	const seen = new Set<string>();
	for (const fixture of manifest) {
		if (
			!fixture ||
			!names.includes(fixture.name) ||
			seen.has(fixture.name) ||
			!Number.isSafeInteger(fixture.bytes) ||
			fixture.bytes < 0 ||
			typeof fixture.file !== "string" ||
			(await realpath(fixture.file)) !== join(root, "agent", "sessions", `${fixture.name}.jsonl`)
		)
			throw new Error("Invalid synthetic fixture path");
		seen.add(fixture.name);
	}
	return manifest;
}
export async function beginIsolatedSessionSwitchProbe(): Promise<void> {
	await assertIsolated();
	beginSessionSwitchProbe();
}
export async function finishIsolatedSessionSwitchProbe() {
	await assertIsolated();
	return finishSessionSwitchProbe();
}
