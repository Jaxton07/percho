import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { beginSessionSwitchProbe, finishSessionSwitchProbe } from "@percho/backend";
import type { SessionSwitchFixture } from "@percho/shared";
import { app } from "electron";

async function assertIsolated(): Promise<string> {
	const root = process.env.PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT;
	if (!root || !isAbsolute(root) || !root.endsWith("/.local/tmp/session-switch-diagnostics")) {
		throw new Error("Session diagnostics require an explicitly isolated test instance");
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
