import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	copyFile,
	cp,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { transform } from "esbuild";
import { retireMacApplication } from "../macos-app-cleanup.mjs";
import { connect } from "../session-rendering-cdp.mjs";
import { runOwnedTask } from "./owned-task.mjs";
import { validateNoSymlinks } from "./paths.mjs";
import { cleanOwnedGroup } from "./process.mjs";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

// Child scripts receive a complete isolated environment; host overrides are deliberately narrower.
export function desktopOverrides(env) {
	const keys = [
		"PERCHO_PERF_RUN_DIR",
		"PERCHO_PERF_OWNER",
		"PERCHO_PERF_SOURCE",
		"PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT",
	];
	return Object.fromEntries(keys.filter((key) => env[key] != null).map((key) => [key, env[key]]));
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function boundedClient(client) {
	const pending = new Set();
	let closed = false;
	const invoke = (method, args) =>
		new Promise((resolveValue, reject) => {
			if (closed) return reject(new Error("Owned desktop connection closed"));
			const finish = (error, value) => {
				clearTimeout(timer);
				pending.delete(fail);
				if (error) reject(error);
				else resolveValue(value);
			};
			const fail = (error) => finish(error);
			const timer = setTimeout(() => fail(new Error(`Desktop ${method} timed out`)), 30000);
			pending.add(fail);
			try {
				Promise.resolve(client[method](...args)).then((value) => finish(null, value), fail);
			} catch (error) {
				fail(error);
			}
		});
	return {
		...client,
		eval: (...args) => invoke("eval", args),
		send: (...args) => invoke("send", args),
		close() {
			if (closed) return;
			closed = true;
			for (const fail of pending) fail(new Error("Owned desktop connection closed"));
			client.close();
		},
	};
}
const within = (parent, child) =>
	child !== parent && !relative(parent, child).startsWith(`..${sep}`) && relative(parent, child) !== "..";
async function port(number = 0) {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(number, "127.0.0.1", () => {
			const result = server.address().port;
			server.close(() => resolvePort(result));
		});
	});
}
async function pidAt(number) {
	const result = await exec("lsof", ["-t", "-nP", `-iTCP:${number}`, "-sTCP:LISTEN"]).catch(() => ({
		stdout: "",
	}));
	const ids = result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
	assert.equal(ids.length, 1, `Expected one listener on ${number}`);
	return ids[0];
}
async function prepare(repo, directory, owner, kind) {
	const host = join(directory, "host");
	await mkdir(host, { mode: 0o700 });
	for (const part of ["out", "build", "resources"])
		await cp(join(repo, "packages/desktop", part), join(host, part), {
			recursive: true,
			verbatimSymlinks: true,
		});
	await writeFile(
		join(host, "package.json"),
		JSON.stringify({
			name: "percho-performance-host",
			version: "0.0.0",
			type: "module",
			main: "out/main/index.js",
		}),
		{ mode: 0o600 },
	);
	await symlink(join(repo, "packages/desktop/node_modules"), join(host, "node_modules"), "dir");
	const assets = join(host, "out/renderer/assets");
	const bundles = (await readdir(assets)).filter((n) => /^workbench-.*\.js$/.test(n));
	assert.equal(bundles.length, 1, "Expected one production workbench bundle; run npm run build first");
	const moduleFile = join(assets, bundles[0]);
	assert.equal(
		await realpath(moduleFile),
		moduleFile,
		"Diagnostic bundle must be a private file, not a symlink",
	);
	const code = `${await readFile(moduleFile, "utf8")}\nexport {useSessionsStore as diagSessions,useTranscriptStore as diagTranscripts,reloadSessionHistory as diagReload,useUiPreferencesStore as diagPrefs,useUiStore as diagUi,getExecutionApi as diagApi,emptyTranscript as diagEmpty,reduceEvent as diagReduce,useSessionViewStore as diagViews,isHistoryReady as diagHistoryReady,isHistoryReady as diagReady,LOCAL_ENVIRONMENT as diagLocal};\n`;
	await transform(code, { loader: "js", format: "esm" });
	await writeFile(moduleFile, code, { mode: 0o600 });
	if (kind === "large-text") {
		const mainFile = join(host, "out/main/index.js");
		assert.equal(await realpath(mainFile), mainFile, "Main bundle must be private");
		const mainCode = await readFile(mainFile, "utf8");
		assert.match(mainCode, /\blet backend;/, "Expected main backend binding");
		await writeFile(mainFile, `${mainCode}\nglobalThis.__perfBackend=()=>backend;\n`);
	}
	const app = join(directory, "Diagnostic.app");
	await exec("ditto", [resolve(dirname(require("electron")), "../.."), app]);
	const channels = JSON.parse(await readFile(join(repo, "packages/desktop/build/app-channels.json"), "utf8"));
	for (const [key, value] of Object.entries({
		CFBundleIdentifier: `${channels.dev.appId}.performance.${owner}`,
		CFBundleDisplayName: channels.dev.name,
		CFBundleName: channels.dev.name,
	}))
		await exec("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, join(app, "Contents/Info.plist")]);
	await exec("codesign", ["--force", "--deep", "--sign", "-", app]);
	return { host, moduleFile, app, executable: join(app, "Contents/MacOS/Electron") };
}

/**
 * Launch a private macOS desktop; the caller owns neither process nor debug ports.
 * Diagnostics use run/work/switch, separate from the new host directory. Pass the run
 * directory and owner marker via PERCHO_PERF_RUN_DIR and PERCHO_PERF_OWNER.
 * Built large-text hosts expose backendStats(); cleanup failures carry cleanupResult.
 */
export async function withDesktop(options, callback) {
	const result = { kind: "desktop", phase: "preparing", completed: false, errors: [], warnings: [] };
	options.cleanupResults?.push(result);
	try {
		return await startDesktop(options, callback, result);
	} catch (error) {
		if (result.phase === "preparing") {
			result.phase = "not-started";
			result.completed = true;
			result.failure = error.message;
			error.cleanupResult ??= result;
		}
		throw error;
	}
}

async function startDesktop(
	{ repo, directory, mode = "built-renderer", kind = "minimap", env = {}, signal },
	callback,
	cleanupResult,
) {
	signal?.throwIfAborted();
	if (process.platform !== "darwin")
		throw Object.assign(new Error("Desktop performance host is supported only on macOS"), {
			code: "UNSUPPORTED_PLATFORM",
		});
	assert(["built-renderer", "dev"].includes(mode), "Unknown desktop mode");
	assert(
		(mode === "built-renderer" ? ["minimap", "rendering", "large-text"] : ["switch", "images"]).includes(
			kind,
		),
		"Unsupported desktop kind",
	);
	repo = await realpath(resolve(repo));
	directory = resolve(directory);
	const base = join(repo, ".local/test/performance");
	const rel = relative(base, directory).split(sep);
	assert(
		rel.length >= 3 && rel[0] !== ".." && rel[1] === "work" && within(base, directory),
		"Desktop directory must be inside a run's work directory",
	);
	const work = join(base, rel[0], "work");
	assert.equal(await realpath(work), work, "Work directory must not contain symlinks");
	await mkdir(directory, { recursive: false, mode: 0o700 });
	assert.equal(await realpath(directory), directory);
	let dataRoot = directory;
	if (env.PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT) {
		dataRoot = resolve(env.PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT);
		assert.equal(dataRoot, join(work, "switch"), "Invalid diagnostics root");
		assert.equal(await realpath(dataRoot), dataRoot, "Diagnostics root must not contain symlinks");
	}
	const agentDir = join(dataRoot, "agent"),
		dataArg = join(dataRoot, "user-data"),
		userDataDir = `${dataArg}-dev`;
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	assert.equal(await realpath(agentDir), agentDir, "Agent directory must not contain symlinks");
	// Fixtures never execute project resources. Restrict only this private agent, not the user's trust policy.
	validateNoSymlinks(join(agentDir, "settings.json"));
	const settings = SettingsManager.create(dataRoot, agentDir, { projectTrusted: false });
	settings.setDefaultProjectTrust("never");
	await settings.flush();
	await mkdir(userDataDir, { recursive: true, mode: 0o700 });
	assert.equal(await realpath(userDataDir), userDataDir, "User data directory must not contain symlinks");
	for (const name of ["home", "tmp", "config", "cache", "data"])
		await mkdir(join(directory, name), { mode: 0o700 });
	const owner = randomUUID();
	if (env.PERCHO_PERF_OWNER !== undefined) {
		const marker = JSON.parse(await readFile(join(dirname(work), "owner.json"), "utf8"));
		assert(
			typeof env.PERCHO_PERF_OWNER === "string" &&
				/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					env.PERCHO_PERF_OWNER,
				) &&
				marker.version === 1 &&
				marker.kind === "percho-performance-run" &&
				marker.owner === env.PERCHO_PERF_OWNER,
			"Performance owner mismatch",
		);
		assert.equal(
			resolve(String(env.PERCHO_PERF_RUN_DIR ?? "")),
			dirname(work),
			"Invalid performance run root",
		);
	}
	// Start from an allowlist, not the invoking user's credentials, runtime overrides or resource paths.
	const cleanEnv = {};
	for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM"])
		if (process.env[key]) cleanEnv[key] = process.env[key];
	for (const [key, value] of Object.entries(env)) {
		if (key === "PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT") {
			cleanEnv[key] = dataRoot;
			continue;
		}
		if (key === "PERCHO_PERF_OWNER") {
			cleanEnv[key] = value;
			continue;
		}
		if (key === "PERCHO_PERF_RUN_DIR") {
			assert.equal(resolve(String(value)), dirname(work), "Invalid performance run root");
			cleanEnv[key] = dirname(work);
			continue;
		}
		if (
			/^(HOME|TMPDIR|TMP|TEMP|XDG_|PI_|PERCHO_|ELECTRON_|NODE_|.*(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH).*)/i.test(
				key,
			)
		)
			throw new Error(`Unsafe desktop environment override: ${key}`);
		cleanEnv[key] = String(value);
	}
	Object.assign(cleanEnv, {
		HOME: join(directory, "home"),
		TMPDIR: join(directory, "tmp"),
		TMP: join(directory, "tmp"),
		TEMP: join(directory, "tmp"),
		XDG_CONFIG_HOME: join(directory, "config"),
		XDG_CACHE_HOME: join(directory, "cache"),
		XDG_DATA_HOME: join(directory, "data"),
		PERCHO_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		MINIMAP_OWNER: owner,
		MINIMAP_DATA: userDataDir,
	});
	const cdpPort = await port(),
		inspectPort = await port();
	assert.notEqual(cdpPort, inspectPort, "Port allocation conflict");
	if (mode === "dev") await port(5173);
	let app,
		child,
		log,
		main,
		renderer,
		pid,
		identityVerified = false;
	cleanupResult.phase = "starting";
	const host = {
		cdpPort,
		inspectPort,
		owner,
		agentDir,
		userDataDir,
		hostDir: null,
		moduleFile: null,
		executable: null,
		env: cleanEnv,
		renderer: null,
		main: null,
		pid: null,
		cleanupResult,
	};
	let failure;
	try {
		log = await open(join(directory, "desktop.log"), "wx", 0o600);
		if (mode === "built-renderer") {
			// Record the owned bundle path even if preparation fails midway.
			app = join(directory, "Diagnostic.app");
			const prepared = await prepare(repo, directory, owner, kind);
			Object.assign(host, {
				hostDir: prepared.host,
				moduleFile: prepared.moduleFile,
				executable: prepared.executable,
			});
		} else Object.assign(host, { hostDir: join(repo, "packages/desktop"), executable: process.execPath });
		const args = [
			`--remote-debugging-port=${cdpPort}`,
			`--inspect=${inspectPort}`,
			`--user-data-dir=${dataArg}`,
		];
		const command = mode === "dev" ? process.execPath : host.executable;
		const launchArgs =
			mode === "dev" ? [join(repo, "scripts/dev-desktop.mjs"), ...args] : [host.hostDir, ...args];
		child = spawn(command, launchArgs, {
			cwd: mode === "dev" ? repo : join(repo, "packages/desktop"),
			env: cleanEnv,
			detached: true,
			stdio: ["ignore", log.fd, log.fd],
		});
		let spawnError;
		child.on("error", (error) => {
			spawnError = error;
		});
		child.once("exit", () => {
			for (const client of [renderer, main]) {
				try {
					client?.close();
				} catch (error) {
					cleanupResult.warnings.push(error.message);
				}
			}
		});
		const deadline = Date.now() + 90000;
		for (;;) {
			signal?.throwIfAborted();
			if (spawnError) throw spawnError;
			assert(child.exitCode === null && child.signalCode === null, "Desktop exited during startup");
			try {
				if (
					(await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).ok &&
					(await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).ok
				)
					break;
			} catch {}
			assert(Date.now() < deadline, "Desktop debugging startup timed out");
			await pause(150);
		}
		pid = await pidAt(inspectPort);
		assert.equal(await pidAt(cdpPort), pid, "Debug ports belong to different processes");
		main = boundedClient(await connect(inspectPort));
		const identity = await main.eval(
			`(()=>{const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');return {pid:process.pid,argv:process.argv,cwd:process.cwd(),appPath:e.app.getAppPath(),exe:e.app.getPath('exe'),userData:e.app.getPath('userData'),owner:process.env.MINIMAP_OWNER}})()`,
		);
		assert.equal(identity.pid, pid);
		assert.equal(identity.owner, owner);
		assert.equal(identity.cwd, join(repo, "packages/desktop"));
		assert.equal(identity.userData, userDataDir);
		assert(identity.argv.includes(`--user-data-dir=${dataArg}`));
		assert.equal(identity.appPath, host.hostDir);
		if (mode === "built-renderer") assert.equal(identity.exe, host.executable);
		else assert(identity.exe.includes(`${sep}.local${sep}runtime${sep}dev.noindex${sep}`));
		identityVerified = true;
		host.pid = pid;
		host.main = main;
		if (kind === "large-text")
			host.backendStats = () => main.eval("globalThis.__perfBackend().getSessionSourceStats()");
		renderer = boundedClient(await connect(cdpPort));
		host.renderer = renderer;
		await renderer.send("Emulation.setFocusEmulationEnabled", { enabled: true });
		for (;;) {
			signal?.throwIfAborted();
			if (
				await renderer.eval(
					"document.documentElement?.dataset.appReady==='true'&&!document.querySelector('#splash')",
				)
			)
				break;
			const startup = await renderer.eval("window.pi?.storageStartupGet().catch(()=>null)");
			if (startup?.phase === "error") throw new Error(String(startup.error));
			if (["existing", "choice"].includes(startup?.phase))
				await renderer.eval(
					`window.pi.storageStartupAct({action:${JSON.stringify(startup.phase === "existing" ? "adopt" : "empty")}})`,
				);
			assert(Date.now() < deadline, "Desktop startup timed out");
			await pause(100);
		}
		return await runOwnedTask(
			{
				signal,
				cancel: () => {
					for (const client of [renderer, main]) {
						try {
							client?.close();
						} catch (error) {
							cleanupResult.errors.push(error.message);
						}
					}
				},
			},
			() => callback(host),
		);
	} catch (error) {
		failure = error;
		if (log) {
			try {
				await log.write(`\nDesktop error: ${error?.stack ?? String(error)}\n`);
			} catch (logError) {
				cleanupResult.errors.push(logError.message);
			}
		}
		throw error;
	} finally {
		const attempt = async (fn) => {
			try {
				await fn();
			} catch (error) {
				cleanupResult.errors.push(error.message);
			}
		};
		const ownsLiveDesktop = async () => {
			if (!identityVerified || !Number.isInteger(host.pid) || host.pid <= 1) return false;
			const state = await exec("/bin/ps", ["-p", String(host.pid), "-o", "stat=,command="]).catch((error) => {
				if (error.code === 1) return { stdout: "" };
				throw error;
			});
			const match = state.stdout.match(/^\s*(\S+)\s+([\s\S]*)$/);
			if (!match || match[1].startsWith("Z")) return false;
			assert(
				match[2].includes(`--user-data-dir=${dataArg}`) &&
					match[2].includes(`--remote-debugging-port=${cdpPort}`),
				"Desktop PID changed ownership; refusing to terminate it",
			);
			return true;
		};
		const soft = async (fn) => {
			try {
				await fn();
			} catch (error) {
				cleanupResult.warnings.push(error.message);
			}
		};
		if (renderer)
			await soft(async () => {
				if (await ownsLiveDesktop())
					await renderer.send("Emulation.setFocusEmulationEnabled", { enabled: false });
			});
		if (main)
			await soft(async () => {
				if (await ownsLiveDesktop())
					await main.eval(
						"process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').app.exit(0)",
					);
			});
		renderer?.close();
		main?.close();
		await attempt(async () => {
			if (await ownsLiveDesktop()) {
				try {
					process.kill(host.pid, "SIGTERM");
				} catch (error) {
					if (error.code !== "ESRCH") throw error;
				}
				await pause(1000);
				if (await ownsLiveDesktop()) process.kill(host.pid, "SIGKILL");
			}
			if (identityVerified) await cleanOwnedGroup({ pid: host.pid });
		});
		if (child?.pid) {
			await Promise.race([
				new Promise((r) =>
					child.exitCode !== null || child.signalCode !== null ? r() : child.once("exit", r),
				),
				pause(5000),
			]);
			await attempt(async () => {
				await cleanOwnedGroup(child);
				if (child.exitCode === null && child.signalCode === null)
					await new Promise((resolveExit) => child.once("exit", resolveExit));
			});
		}
		if (log) {
			await attempt(() => log.close());
			await attempt(async () => {
				const logs = join(dirname(work), "logs");
				validateNoSymlinks(logs);
				await mkdir(logs, { recursive: true, mode: 0o700 });
				const archive = join(logs, `desktop-${owner}.log`);
				validateNoSymlinks(archive);
				await copyFile(join(directory, "desktop.log"), archive, constants.COPYFILE_EXCL);
				await chmod(archive, 0o600);
			});
		}
		if (app) await attempt(() => retireMacApplication(app, { remove: true }));
		for (const n of [cdpPort, inspectPort, ...(mode === "dev" ? [5173] : [])]) await attempt(() => port(n));
		cleanupResult.completed = cleanupResult.errors.length === 0;
		cleanupResult.phase = cleanupResult.completed ? "closed" : "cleanup-failed";
		// Cleanup failures must be visible even when the callback was already failing.
		if (!cleanupResult.completed)
			// biome-ignore lint/correctness/noUnsafeFinally: cleanup failure must not be silently ignored
			throw Object.assign(
				new Error(
					`${failure ? `${failure.message}; ` : ""}Desktop cleanup failed: ${cleanupResult.errors.join("; ")}`,
					{ cause: failure },
				),
				{
					cleanupResult,
				},
			);
	}
}
