#!/usr/bin/env node
/** Owns one frozen diagnostic Electron process group, CDP collector, logs and cleanup.
 * Prepare with prepare-session-rendering-host.mjs first. Refuses occupied ports.
 * Usage: node scripts/run-session-rendering.mjs baseline-prod [--smoke]
 * After rebuilding and preparing --after: node scripts/run-session-rendering.mjs after-final --after
 * Short comparison: add --short (80 tools, three rounds). Full interaction/resource checks:
 * add --interactions-only --resources. Run latency measurements without builds/tests in parallel.
 * Each invocation closes only its owned process group and verifies both ports are released.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { suiteRoot } from "./performance/paths.mjs";

const repo = resolve(import.meta.dirname, ".."),
	root = suiteRoot(repo, "rendering", ".local/tmp/session-rendering-baseline", "PERCHO_RENDERING_ROOT");
const cdp = Number(process.env.PERCHO_CDP_PORT ?? 9244),
	inspect = Number(process.env.PERCHO_INSPECT_PORT ?? 9245);
assert.equal(await realpath(root), root);
for (const port of [cdp, inspect])
	await new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => server.close(resolve));
	});
const executable = resolve(root, "Percho Rendering Diagnostic.app/Contents/MacOS/Electron");
const agent = resolve(root, "agent"),
	userData = resolve(root, "user-data"),
	host = resolve(root, process.argv.includes("--after") ? "frozen-after-host" : "frozen-host");
assert.equal(await realpath(agent), agent);
assert.equal((await stat(agent)).mode & 0o077, 0);
const log = await open(resolve(root, "production.log"), "w", 0o600);
const env = { ...process.env, PERCHO_AGENT_DIR: agent };
delete env.ELECTRON_RENDERER_URL;
const child = spawn(
	executable,
	[host, `--remote-debugging-port=${cdp}`, `--inspect=${inspect}`, `--user-data-dir=${userData}`],
	{ cwd: repo, env, detached: true, stdio: ["ignore", log.fd, log.fd] },
);
let collector;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
try {
	const until = Date.now() + 30000;
	for (;;) {
		if (child.exitCode !== null || child.signalCode !== null)
			throw new Error("Diagnostic Electron exited before ready");
		try {
			if (
				(await fetch(`http://127.0.0.1:${cdp}/json/list`)).ok &&
				(await fetch(`http://127.0.0.1:${inspect}/json/list`)).ok
			)
				break;
		} catch {}
		if (Date.now() > until) throw new Error("Diagnostic ports did not become ready");
		await pause(100);
	}
	collector = spawn(
		process.execPath,
		[
			resolve(repo, "scripts/check-session-rendering.mjs"),
			process.argv[2] ?? "baseline-prod",
			"--production",
			...process.argv.slice(3),
		],
		{ cwd: repo, env: { ...process.env, PERCHO_RENDERING_OWNER_PID: String(child.pid) }, stdio: "inherit" },
	);
	const code = await new Promise((resolve, reject) => {
		collector.once("error", reject);
		collector.once("exit", resolve);
	});
	if (code !== 0) throw new Error(`Collector exited ${code}`);
} finally {
	if (collector?.exitCode === null && collector?.signalCode === null) collector.kill("SIGTERM");
	if (child.exitCode === null && child.signalCode === null) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {}
		await Promise.race([new Promise((r) => child.once("exit", r)), pause(2000)]);
		if (child.exitCode === null && child.signalCode === null) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}
	}
	await log.close();
	await pause(300);
	for (const port of [cdp, inspect])
		await new Promise((resolve, reject) => {
			const server = createServer();
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => server.close(resolve));
		});
}
