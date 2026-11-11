import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { archiveSuiteArtifacts } from "./artifacts.mjs";
import { validateNoSymlinks } from "./paths.mjs";
import { runProcess } from "./process.mjs";
import { RunStore } from "./store.mjs";
import { defaults, runSuite, SUITES } from "./suites.mjs";

const exec = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const help = `Percho performance tests (macOS desktop, POSIX Node catalog)

npm run perf -- run [--profile=quick|full] [--suite=minimap,rendering,large-text,switch,images,catalog] [--label=text] [--keep-work]
npm run perf -- history [--json]
npm run perf -- compare <id> [--baseline=<id>] [--suite=large-text] [--json]
npm run perf -- baseline set <id>
npm run perf -- import --file=<old-report.json> --suite=minimap [--label=text]

quick defaults: minimap, large-text, catalog; full defaults: every suite, serially.
Each run is kept in .local/test/performance/<id> including failures and raw data.
No automatic baseline promotion. Unknown legacy metadata is reference-only.
Do not interact with the diagnostic desktop during sampling. Existing applications are not closed.
`;
function parse(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: {
			profile: { type: "string", default: "quick" },
			suite: { type: "string" },
			label: { type: "string", default: "" },
			baseline: { type: "string" },
			file: { type: "string" },
			json: { type: "boolean" },
			"keep-work": { type: "boolean" },
			help: { type: "boolean" },
		},
	});
	if (!values.help && !["run", "history", "compare", "baseline", "import"].includes(positionals[0]))
		throw new Error("Choose run, history, compare, baseline set, or import; see --help");
	if (!["quick", "full"].includes(values.profile)) throw new Error("Unknown profile");
	if (values.label.length > 160 || Array.from(values.label).some((character) => character.charCodeAt(0) < 32))
		throw new Error("Invalid performance label");
	const suites = values.suite ? values.suite.split(",") : defaults(values.profile);
	if (suites.some((name) => !SUITES.includes(name)) || new Set(suites).size !== suites.length)
		throw new Error("Unknown or duplicated performance suite");
	return { ...values, command: positionals[0], positional: positionals.slice(1), suites };
}
async function provenance(repo) {
	const git = async (...args) => (await exec("git", args, { cwd: repo, maxBuffer: 32 * 1024 * 1024 })).stdout;
	const status = await git("status", "--porcelain");
	const diff = await git("diff", "--binary", "HEAD");
	const commit = (await git("rev-parse", "HEAD")).trim();
	const require = createRequire(join(repo, "package.json"));
	const sdkFile = resolve(
		dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
		"../package.json",
	);
	const sdk = JSON.parse(await readFile(sdkFile, "utf8")).version;
	const electron = JSON.parse(await readFile(require.resolve("electron/package.json"), "utf8")).version;
	return {
		source: {
			commit,
			dirty: !!status.trim(),
			diffHash: sha(diff),
			untracked: status.split("\n").filter((line) => line.startsWith("??")).length,
		},
		environment: {
			platform: platform(),
			arch: arch(),
			osRelease: release(),
			cpuModel: cpus()[0]?.model ?? "unknown",
			machineHash: sha(`${hostname()}|${cpus()[0]?.model}|${totalmem()}`),
			node: process.version,
			electron,
			sdk,
		},
	};
}
async function lock(root) {
	validateNoSymlinks(root);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const path = join(root, ".run-lock");
	let handle;
	try {
		handle = await open(
			path,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600,
		);
	} catch (error) {
		if (error.code === "EEXIST")
			throw new Error(
				"A performance run lock exists. Do not overlap sampling; inspect .run-lock and confirm its owner exited before removing a stale lock.",
			);
		throw error;
	}
	const owner = randomUUID();
	await handle.writeFile(JSON.stringify({ owner, pid: process.pid, startedAt: new Date().toISOString() }));
	await handle.close();
	return async () => {
		if ((await lstat(path)).isSymbolicLink()) throw new Error("Performance lock was replaced");
		if (JSON.parse(await readFile(path, "utf8")).owner !== owner)
			throw new Error("Performance lock belongs to another run");
		await unlink(path);
	};
}
async function isolatedEnvironment(runDir, owner) {
	const base = join(runDir, "work/environment");
	for (const name of ["home", "config", "cache", "tmp", "agent"])
		await mkdir(join(base, name), { recursive: true, mode: 0o700 });
	return {
		PATH: process.env.PATH ?? "",
		LANG: "en_US.UTF-8",
		HOME: join(base, "home"),
		XDG_CONFIG_HOME: join(base, "config"),
		XDG_CACHE_HOME: join(base, "cache"),
		TMPDIR: join(base, "tmp"),
		TMP: join(base, "tmp"),
		TEMP: join(base, "tmp"),
		PI_CODING_AGENT_DIR: join(base, "agent"),
		PERCHO_AGENT_DIR: join(base, "agent"),
		PERCHO_PERF_RUN_DIR: runDir,
		PERCHO_PERF_OWNER: owner,
		NODE_OPTIONS: "--no-experimental-webstorage --max-old-space-size=8192",
	};
}
async function execute(repo, store, options) {
	const unlock = await lock(store.root);
	const controller = new AbortController();
	const interrupt = () => controller.abort(new Error("Performance run interrupted"));
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	let run;
	let error;
	const cleanupResults = [];
	const clean = (message) => String(message).split(repo).join("<repo>");
	try {
		run = await store.create({ profile: options.profile, label: options.label });
		Object.assign(run, await provenance(repo));
		const runDir = join(store.root, run.id);
		const owner = randomUUID();
		await writeFile(
			join(runDir, "owner.json"),
			`${JSON.stringify({ version: 1, kind: "percho-performance-run", owner })}\n`,
			{ mode: 0o600, flag: "wx" },
		);
		const env = await isolatedEnvironment(runDir, owner);
		const runCommand = async (
			args,
			{ log, env: childEnv = env, cwd = repo, command = process.execPath, timeoutMs } = {},
		) => {
			if (!/^[a-zA-Z0-9_.-]+\.log$/.test(log ?? "")) throw new Error("Expected an owned log filename");
			return runProcess({
				command,
				args,
				cwd,
				env: childEnv,
				logFile: join(runDir, "logs", log),
				signal: controller.signal,
				timeoutMs,
			});
		};
		const selected = SUITES.filter((suite) => options.suites.includes(suite));
		for (const name of selected)
			run.suites[name] = { status: "pending", contract: null, metrics: [], rawFiles: [], notes: [] };
		if (run.source.untracked)
			run.notes.push(
				"Provenance includes untracked paths, not their contents. Commit source before claiming a reproducible baseline.",
			);
		await store.save(run);
		if (process.platform === "darwin" && selected.some((name) => name !== "catalog")) {
			await runCommand(["run", "build"], {
				log: "production-build.log",
				command: process.platform === "win32" ? "npm.cmd" : "npm",
			});
		}
		for (const name of selected) {
			controller.signal.throwIfAborted();
			if ((name !== "catalog" && process.platform !== "darwin") || process.platform === "win32") {
				run.suites[name] = {
					...run.suites[name],
					status: "skipped",
					notes: [
						"Desktop automation currently supports macOS; unified command-tree cleanup supports POSIX. Unsupported suites are not passed tests.",
					],
				};
				continue;
			}
			run.suites[name].status = "running";
			await store.save(run);
			let suiteError;
			try {
				run.suites[name] = await runSuite(name, {
					repo,
					runDir,
					profile: options.profile,
					env,
					runCommand,
					cleanupResults,
					signal: controller.signal,
				});
			} catch (caught) {
				run.suites[name].status = controller.signal.aborted ? "interrupted" : "failed";
				run.suites[name].notes.push(clean(caught.message));
				if (caught.cleanupResult && !cleanupResults.includes(caught.cleanupResult))
					cleanupResults.push(caught.cleanupResult);
				suiteError = caught;
			}
			try {
				const artifacts = await archiveSuiteArtifacts({ runDir, suite: name });
				run.suites[name].rawFiles = [...new Set([...run.suites[name].rawFiles, ...artifacts])];
			} catch (archiveError) {
				run.suites[name].status = "failed";
				run.suites[name].notes.push(`Artifact archive failed: ${clean(archiveError.message)}`);
				suiteError ??= archiveError;
			}
			await store.save(run);
			if (suiteError) throw suiteError;
		}
		controller.signal.throwIfAborted();
		run.status = Object.values(run.suites).every((suite) => suite.status === "passed") ? "passed" : "partial";
	} catch (caught) {
		error = caught;
		if (!run) throw caught;
		run.status = controller.signal.aborted ? "interrupted" : "failed";
		run.notes.push(clean(caught.message));
		if (caught.cleanupResult && !cleanupResults.includes(caught.cleanupResult))
			cleanupResults.push(caught.cleanupResult);
	} finally {
		try {
			if (run) {
				if (controller.signal.aborted && run.status === "passed") run.status = "interrupted";
				for (const suite of Object.values(run.suites))
					if (suite.status === "pending" || suite.status === "running") {
						suite.status = "skipped";
						suite.notes.push("Not completed because the run stopped.");
					}
				run.finishedAt = new Date().toISOString();
				run.cleanup = {
					completed: cleanupResults.every((result) => result.completed),
					operations: cleanupResults.map((result) => ({
						...result,
						...(result.failure ? { failure: clean(result.failure) } : {}),
						errors: result.errors?.map(clean) ?? [],
					})),
				};
				if (!run.cleanup.completed) run.status = "failed";
				run.cleanup.workRetained = run.status !== "passed" || !!options["keep-work"];
				if (!run.cleanup.workRetained) {
					try {
						await rm(join(store.root, run.id, "work"), { recursive: true });
					} catch (caught) {
						error ??= caught;
						run.status = "failed";
						run.cleanup.completed = false;
						run.cleanup.workRetained = true;
						run.cleanup.errors = [`Work removal incomplete: ${clean(caught.message)}`];
						run.notes.push(...run.cleanup.errors);
					}
				}
				await store.save(run);
				await store.writeHistory();
			}
		} finally {
			try {
				await unlock();
			} finally {
				process.removeListener("SIGINT", interrupt);
				process.removeListener("SIGTERM", interrupt);
			}
		}
	}
	return { run, error };
}
export async function main(argv = process.argv.slice(2)) {
	const options = parse(argv);
	if (options.help) {
		console.log(help);
		return 0;
	}
	const repo = await realpath(resolve(import.meta.dirname, "../.."));
	const store = new RunStore({ root: join(repo, ".local/test/performance") });
	if (options.command === "run") {
		if (options.positional.length) throw new Error("Unexpected run argument");
		const { run, error } = await execute(repo, store, options);
		if (options.json) console.log(JSON.stringify(run));
		else {
			console.log(`${run.status}: ${run.id}\n.local/test/performance/${run.id}/report.md`);
			if (error) console.error(error.message);
		}
		return run.status === "interrupted" ? 130 : run.status === "passed" ? 0 : 1;
	}
	if (options.command === "history") {
		if (options.positional.length) throw new Error("Unexpected history argument");
		const runs = await store.list();
		await store.writeHistory();
		if (options.json) console.log(JSON.stringify(runs));
		else {
			for (const run of runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt)))
				console.log(`${run.id}  ${run.status}  ${run.profile ?? "legacy"}  ${run.label}`);
			console.log(".local/test/performance/history.html");
		}
		return 0;
	}
	if (options.command === "baseline") {
		if (options.positional.length !== 2 || options.positional[0] !== "set")
			throw new Error("Use baseline set <id>");
		await store.setBaseline(options.positional[1]);
		console.log(
			options.json
				? JSON.stringify({ baselineId: options.positional[1] })
				: `Baseline: ${options.positional[1]}`,
		);
		return 0;
	}
	if (options.command === "import") {
		if (!options.file || options.suites.length !== 1 || options.positional.length)
			throw new Error("Use import --file=<report> --suite=minimap");
		const run = await store.importLegacy({
			file: resolve(options.file),
			suite: options.suites[0],
			label: options.label,
		});
		await store.writeHistory();
		console.log(
			options.json
				? JSON.stringify(run)
				: `Imported ${run.id}: reference-only; unknown metadata is not a baseline.`,
		);
		return 0;
	}
	if (options.positional.length !== 1) throw new Error("Use compare <id> --baseline=<id>");
	const baselineId = options.baseline ?? (await store.getBaseline());
	if (!baselineId) throw new Error("Choose --baseline=<id> or explicitly set a baseline first");
	const comparison = await store.compare(options.positional[0], {
		baselineId,
		suiteNames: options.suite ? options.suites : undefined,
	});
	if (options.json) console.log(JSON.stringify(comparison));
	else {
		console.log(`${comparison.status}: ${comparison.currentId} vs ${comparison.baselineId}`);
		for (const suite of comparison.suites) {
			console.log(
				`${suite.name}: ${suite.status}${suite.reasons.length ? ` (${suite.reasons.join("; ")})` : ""}`,
			);
			for (const point of suite.metrics ?? [])
				console.log(
					`  ${point.name}: ${point.before} → ${point.after} ${point.unit} (${point.delta >= 0 ? "+" : ""}${Number(point.delta.toFixed(3))})`,
				);
		}
	}
	return comparison.status === "comparable" ? 0 : 2;
}
