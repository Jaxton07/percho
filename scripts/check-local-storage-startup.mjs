/** Native packaged-app smoke; all agent/profile writes stay in .local/tmp.
 * Usage: node scripts/check-local-storage-startup.mjs --app <absolute executable>
 * Requires the production build/package; never starts the user's installed application.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.argv[3];
assert.equal(process.argv[2], "--app");
assert.ok(executable && isAbsolute(executable), "Pass the packaged executable's absolute path");
assert.ok((await stat(executable)).isFile());
const evidence = join(root, ".local/tmp/local-storage-startup-check");
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(join(evidence, "native-"));
const helper = join(run, "private-directory.mjs");
await build({
	entryPoints: [join(root, "packages/backend/src/storage/private-directory.ts")],
	outfile: helper,
	bundle: true,
	platform: "node",
	format: "esm",
});
const { privateDirectory } = await import(pathToFileURL(helper).href);
const results = [];
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function wait(check, description, timeout = 45000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await check()) return;
		await pause();
	}
	throw new Error(`Timed out: ${description}`);
}
async function unusedPort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}
async function connect(port, child) {
	let page;
	await wait(async () => {
		assert.equal(child.exitCode, null, "Application exited before renderer connected");
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json`, {
				signal: AbortSignal.timeout(1000),
			});
			page = (await response.json()).find((p) => p.type === "page" && p.url.startsWith("file:"));
			return !!page;
		} catch {
			return false;
		}
	}, "native renderer");
	const socket = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	let id = 0;
	const pending = new Map();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const call = pending.get(message.id);
		if (!call) return;
		pending.delete(message.id);
		clearTimeout(call.timer);
		if (message.error) call.reject(new Error(JSON.stringify(message.error)));
		else call.resolve(message.result);
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const key = ++id;
			const timer = setTimeout(() => {
				pending.delete(key);
				reject(new Error(`CDP timeout: ${method}`));
			}, 15000);
			pending.set(key, { resolve, reject, timer });
			socket.send(JSON.stringify({ id: key, method, params }));
		});
	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
		return result.result.value;
	};
	await send("Emulation.setFocusEmulationEnabled", { enabled: true });
	return {
		pageId: page.id,
		socket,
		evaluate,
		async click(selector, { exitsApp = false } = {}) {
			const point = await evaluate(`(() => {
				const button = document.querySelector(${JSON.stringify(selector)});
				if (!button) throw Error('Missing startup action');
				button.scrollIntoView({block:'nearest'});
				const r = button.getBoundingClientRect(), x = r.x+r.width/2, y=r.y+r.height/2;
				if (!button.contains(document.elementFromPoint(x,y))) throw Error('Button covered');
				return {x,y};
			})()`);
			for (const type of ["mousePressed", "mouseReleased"]) {
				const delivered = send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
				// Quit can close CDP before release is acknowledged; the child-exit assertion verifies it.
				if (exitsApp && type === "mouseReleased") void delivered.catch(() => undefined);
				else await delivered;
			}
		},
		async close() {
			for (const call of pending.values()) {
				clearTimeout(call.timer);
				call.reject(new Error("CDP closed"));
			}
			pending.clear();
			socket.close();
		},
	};
}
async function scenario(name, agent, action) {
	const port = await unusedPort();
	const profile = join(run, `profile-${name}`);
	const env = { ...process.env, PERCHO_AGENT_DIR: agent, SHELL: "/usr/bin/false" };
	delete env.PI_CODING_AGENT_DIR;
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.ELECTRON_RENDERER_URL;
	if (name === "legacy-env") {
		delete env.PERCHO_AGENT_DIR;
		env.PI_CODING_AGENT_DIR = agent;
	}
	const child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
		cwd: root,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = "",
		closed = false,
		failure;
	child.stdout.on("data", (data) => {
		log += data;
	});
	child.stderr.on("data", (data) => {
		log += data;
	});
	child.once("error", (error) => {
		failure = error;
	});
	child.once("exit", () => {
		closed = true;
	});
	let ui;
	try {
		ui = await connect(port, child);
		const timeOrigin = await ui.evaluate(`(() => {
			window.__startupSmoke = { setupSeen: !!document.querySelector('.startup-layout') };
			const observer = new MutationObserver(() => {
				if (document.querySelector('.startup-layout')) window.__startupSmoke.setupSeen = true;
			});
			observer.observe(document, { childList: true, subtree: true });
			return performance.timeOrigin;
		})()`);
		const expectsSetup = action === "adopt" || name === "legacy-env";
		await wait(
			() =>
				ui.evaluate(
					expectsSetup
						? "!!window.pi && document.documentElement?.dataset.startupView==='setup' && !!document.querySelector('.startup-layout')"
						: "!!window.pi && document.documentElement?.dataset.appReady==='true' && !document.getElementById('splash')",
				),
			expectsSetup ? "interactive storage setup" : "interactive workbench",
		);
		if (name === "legacy-env") {
			await wait(
				() =>
					ui.evaluate(
						"window.pi.storageStartupGet().then(s => s.phase==='error' && s.error.includes('PERCHO_LEGACY_AGENT_ENV'))",
					),
				"legacy override rejection",
			);
			await assert.rejects(stat(agent), { code: "ENOENT" });
			await ui.click(".startup-footer > div:first-child button", { exitsApp: true });
		} else {
			if (action === "adopt") {
				await wait(
					() => ui.evaluate("window.pi.storageStartupGet().then(s => s.phase==='existing')"),
					"adoption choice",
				);
				await assert.rejects(stat(join(agent, ".percho-local-storage.json")), { code: "ENOENT" });
				assert.equal(
					await ui.evaluate("window.pi.getAppInfo().then(()=>false,()=>true)"),
					true,
					"Normal IPC must not start before adoption",
				);
				await ui.click("main[data-phase='existing'] .startup-footer > div:last-child button");
			}
			await wait(
				() =>
					ui.evaluate(
						"document.documentElement?.dataset.appReady==='true' && !document.getElementById('splash') && !document.querySelector('.startup-layout')",
					),
				"normal workbench",
			);
			assert.equal(await ui.evaluate("performance.timeOrigin"), timeOrigin, "Startup must not navigate");
			const pages = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(
				(page) => page.type === "page" && page.url.startsWith("file:"),
			);
			assert.equal(pages.length, 1, "Startup must keep a single window");
			assert.equal(pages[0].id, ui.pageId, "Workbench must reuse the setup page");
			if (action !== "adopt")
				assert.equal(await ui.evaluate("window.__startupSmoke.setupSeen"), false, "Unexpected setup page");
			const record = JSON.parse(await readFile(join(agent, ".percho-local-storage.json"), "utf8"));
			assert.equal(record.kind, action === "adopt" ? "adopt" : "empty");
			await privateDirectory(agent, false);
			assert.ok(await ui.evaluate("window.pi.getAppInfo().then(info => !!info.version)"));
			await ui.evaluate("void window.pi.confirmQuit(); true");
			results.push({ name, recordId: record.id, kind: record.kind, singlePage: true });
		}
		await wait(() => closed, "native process exit", 15000);
		if (failure) throw failure;
		assert.equal(child.exitCode, 0);
		if (name === "legacy-env") results.push({ name, rejectedBeforeMkdir: true });
	} finally {
		await ui?.close();
		if (!closed && child.pid) {
			if (process.platform === "win32") {
				await new Promise((resolve) =>
					spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]).once("exit", resolve),
				);
			} else child.kill("SIGTERM");
		}
		await writeFile(join(run, `${name}.log`), log);
	}
}
try {
	const adopted = join(run, "agent-采用");
	await mkdir(adopted, { mode: 0o700 });
	await privateDirectory(adopted, true);
	await writeFile(join(adopted, "sentinel"), "must survive adoption");
	await scenario("adopt", adopted, "adopt");
	assert.equal(await readFile(join(adopted, "sentinel"), "utf8"), "must survive adoption");
	const fresh = join(run, "agent-new");
	await scenario("fresh", fresh, "empty");
	await scenario("restart", fresh, "empty");
	assert.equal(
		results.find((r) => r.name === "fresh").recordId,
		results.find((r) => r.name === "restart").recordId,
	);
	await scenario("legacy-env", join(run, "must-not-be-created"));
	await writeFile(
		join(run, "result.json"),
		`${JSON.stringify({ passed: true, platform: process.platform, results }, null, 2)}\n`,
	);
	console.log(JSON.stringify({ passed: true, platform: process.platform, results, evidence: run }));
} catch (error) {
	await writeFile(join(run, "failure.txt"), String(error.stack ?? error));
	throw error;
}
