import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { suiteRoot, validateNoSymlinks, validateWorkPath } from "./performance/paths.mjs";

const script = fileURLToPath(import.meta.url);
const repo = resolve(dirname(script), "..");
const tempRoot = join(repo, ".local", "tmp");
const workerPath = join(repo, "packages/backend/src/session/catalog-worker.ts");
const count = Number(process.argv[2]);
if (![1000, 10000].includes(count))
	throw new Error("Usage: node scripts/bench-session-catalog.mjs 1000|10000");

const catalogRoot = process.env.PERCHO_PERF_RUN_DIR
	? suiteRoot(repo, "catalog", ".local/tmp", "PERCHO_CATALOG_ROOT")
	: null;
const phase = process.argv[3];
if (phase) {
	if (!["first", "existing"].includes(phase) || !process.env.CATALOG_BENCH_DIR)
		throw new Error("Invalid child phase");
	const root = await realpath(catalogRoot ? join(catalogRoot, String(count)) : tempRoot);
	const data = await realpath(process.env.CATALOG_BENCH_DIR);
	if (dirname(data) !== root || !basename(data).startsWith("session-catalog-bench-")) {
		throw new Error("Invalid benchmark directory");
	}
	await runPhase(data, phase);
} else {
	const parent = catalogRoot ? join(catalogRoot, String(count)) : tempRoot;
	if (catalogRoot) validateWorkPath(repo, parent);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const data = await mkdtemp(join(parent, "session-catalog-bench-"));
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PI_") || key.startsWith("XDG_") || key === "NODE_OPTIONS") delete process.env[key];
	}
	const isolated = {};
	for (const [key, dir] of Object.entries({
		HOME: "home",
		USERPROFILE: "home",
		PI_CODING_AGENT_DIR: "pi",
		XDG_CONFIG_HOME: "xdg-config",
		XDG_CACHE_HOME: "xdg-cache",
		XDG_DATA_HOME: "xdg-data",
		XDG_STATE_HOME: "xdg-state",
		XDG_RUNTIME_DIR: "xdg-runtime",
		TMPDIR: "tmp",
		TMP: "tmp",
		TEMP: "tmp",
	})) {
		isolated[key] = join(data, dir);
		await mkdir(isolated[key], { recursive: true });
	}
	Object.assign(process.env, isolated);
	// Only the host class needs transformation. The real worker and its TS dependencies run in Node.
	const { transform } = await import("esbuild");
	const source = join(repo, "packages/backend/src/session/catalog.ts");
	const compiled = await transform(await readFile(source, "utf8"), {
		loader: "ts",
		format: "esm",
		target: "node22",
	});
	await writeFile(join(data, "catalog.mjs"), compiled.code, { flag: "wx" });
	await mkdir(join(data, "sessions", "large-project"), { recursive: true });
	for (let i = 0; i < count; i++) {
		const header = {
			type: "session",
			id: `id-${i}`,
			cwd: i < count * 0.9 ? "/large-project" : `/project-${i % 10}`,
			timestamp: "2024-01-01T00:00:00Z",
		};
		const body = {
			type: "message",
			timestamp: "2024-01-02T00:00:00Z",
			message: { role: "user", content: "x".repeat(i < 10 ? 262144 : 256) },
		};
		await writeFile(
			sessionFile(data, i),
			`${[header, { type: "session_info", name: `needle session ${i}` }, body].map(JSON.stringify).join("\n")}\n`,
			{ flag: "wx" },
		);
	}
	const phases = [];
	for (const childPhase of ["first", "existing"]) {
		const child = spawnSync(process.execPath, [script, String(count), childPhase], {
			encoding: "utf8",
			env: { ...process.env, CATALOG_BENCH_DIR: data },
			timeout: 900000,
		});
		if (child.status !== 0)
			throw new Error(
				`${childPhase} failed: ${child.error ?? child.signal ?? child.status}\n${child.stderr}\n${child.stdout}`,
			);
		phases.push(JSON.parse(child.stdout));
	}
	const result = {
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		cache: "Fixtures just written; OS cache may be warm. New processes are not cold disk runs.",
		dataset: {
			sessions: count,
			largeProject: count * 0.9,
			otherProjects: 10,
			longBodies: 10,
			longBodyBytes: 262144,
			shortBodyBytes: 256,
			archiveProjection: count * 0.8,
		},
		phases,
	};
	const failures = checkBudget(result);
	result.budgetFailures = failures;
	const resultPath = join(data, "results.json");
	await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
	if (process.env.PERCHO_CATALOG_REPORT_FILE) {
		if (!catalogRoot) throw new Error("Report requires a performance run");
		const report = validateNoSymlinks(process.env.PERCHO_CATALOG_REPORT_FILE);
		const raw = join(resolve(process.env.PERCHO_PERF_RUN_DIR), "raw");
		if (dirname(report) !== raw || !/^catalog-\d+\.json$/.test(basename(report)))
			throw new Error("Invalid catalog report path");
		if ((await realpath(raw)) !== raw) throw new Error("Invalid report directory");
		await writeFile(report, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	}
	console.log(JSON.stringify(result, null, 2));
	console.log(
		`${failures.length ? "FAIL" : "PASS"} ${relative(repo, resultPath)}: local regression budgets, not SLA`,
	);
	if (failures.length) process.exitCode = 1;
}

function sessionFile(data, i) {
	return join(data, "sessions", "large-project", `${String(i).padStart(5, "0")}.jsonl`);
}

async function runPhase(data, phase) {
	const { SessionCatalog } = await import(pathToFileURL(join(data, "catalog.mjs")).href);
	const indexPath = join(data, "index.db");
	if (phase === "existing") await readFile(indexPath);
	const delay = monitorEventLoopDelay({ resolution: 10 });
	delay.enable();
	let peak = process.memoryUsage().rss;
	const timer = setInterval(() => {
		peak = Math.max(peak, process.memoryUsage().rss);
	}, 10);
	const catalog = new SessionCatalog({ sessionsDir: join(data, "sessions"), indexPath, workerPath });
	const measure = async (fn) => {
		const t = performance.now();
		const value = await fn();
		return { ms: performance.now() - t, value };
	};
	try {
		const started = performance.now();
		const building = catalog.refresh();
		const early = await measure(() => catalog.query({ limit: 6 }));
		let page = early.value;
		let polls = 1;
		while (!page.sessions.length && !page.complete && !page.errors) {
			await new Promise((done) => setTimeout(done, 5));
			page = await catalog.query({ limit: 6 });
			polls++;
		}
		const firstNonempty = {
			elapsedMs: performance.now() - started,
			count: page.sessions.length,
			complete: page.complete,
			errors: page.errors,
			polls,
		};
		await building;
		const refreshTotalMs = performance.now() - started;
		const first = await measure(() => catalog.query({ limit: 6, search: "needle" }));
		const next = await measure(() =>
			catalog.query({ limit: 16, search: "needle", cursor: first.value.nextCursor }),
		);
		const refs = Array.from({ length: 100 }, (_, i) => ({
			sessionId: `id-${i}`,
			sessionFile: sessionFile(data, i),
		}));
		const verify = await measure(() => catalog.verify(refs));
		await appendFile(
			sessionFile(data, 20),
			`${JSON.stringify({ type: "session_info", name: "needle changed" })}\n`,
		);
		const increment = await measure(() => catalog.invalidate(sessionFile(data, 20)));
		let archived;
		if (phase === "existing") {
			const projection = Array.from({ length: count * 0.8 }, (_, i) => ({
				path: sessionFile(data, i),
				archivedAt: 1700000000000 + i,
				archiveRevision: 1,
			}));
			const snapshot = await measure(() => catalog.setArchiveOverlay(projection));
			const archiveFirst = await measure(() => catalog.query({ archived: true, limit: 6, search: "needle" }));
			const archiveVerify = await measure(() => catalog.verify(refs));
			archived = {
				projectionMs: snapshot.ms,
				firstMs: archiveFirst.ms,
				count: archiveFirst.value.sessions.length,
				total: archiveFirst.value.total,
				verify100Ms: archiveVerify.ms,
				archivedCount: archiveVerify.value.filter((v) => v.status === "archived").length,
			};
		}
		if (
			early.value.errors ||
			firstNonempty.errors ||
			first.value.errors ||
			next.value.errors ||
			first.value.sessions.length !== 6 ||
			!first.value.nextCursor ||
			next.value.sessions.length !== 16 ||
			verify.value.length !== 100 ||
			verify.value.some((v) => v.status !== "present") ||
			(phase === "first" && (!firstNonempty.count || firstNonempty.complete)) ||
			(archived && (archived.count !== 6 || archived.total !== count * 0.8 || archived.archivedCount !== 100))
		)
			throw new Error(`Unexpected results: ${JSON.stringify({ firstNonempty, archived })}`);
		console.log(
			JSON.stringify({
				phase,
				early: { ms: early.ms, available: early.value.sessions.length, complete: early.value.complete },
				firstNonempty,
				refreshTotalMs,
				searchFirstMs: first.ms,
				searchNextMs: next.ms,
				verify100Ms: verify.ms,
				verifiedPresent: verify.value.length,
				invalidateMs: increment.ms,
				archived,
				eventLoopDelayP99Ms: delay.percentile(99) / 1e6,
				eventLoopDelayMaxMs: delay.max / 1e6,
				peakRssBytes: Math.max(peak, process.memoryUsage().rss),
			}),
		);
	} finally {
		clearInterval(timer);
		delay.disable();
		await catalog.dispose();
	}
}

function checkBudget(data) {
	const failures = [];
	const scale = data.dataset.sessions / 1000;
	for (const p of data.phases) {
		const limits = {
			refreshTotalMs: (p.phase === "first" ? 15000 : 4000) * scale,
			searchFirstMs: 200,
			searchNextMs: 200,
			verify100Ms: 2000,
			invalidateMs: 500,
			eventLoopDelayP99Ms: 200,
			peakRssBytes: 512 * 1024 * 1024,
		};
		for (const [key, max] of Object.entries(limits))
			if (!Number.isFinite(p[key]) || p[key] > max)
				failures.push(`${p.phase}.${key}=${p[key]} exceeds ${max}`);
		if (!Number.isFinite(p.early.ms) || p.early.ms > 1000 * scale)
			failures.push(`${p.phase}.early exceeds budget`);
		if (
			p.phase === "first" &&
			(!p.firstNonempty.count ||
				p.firstNonempty.complete ||
				!Number.isFinite(p.firstNonempty.elapsedMs) ||
				p.firstNonempty.elapsedMs > 1000 * scale)
		)
			failures.push(`${p.phase}: partial nonempty page missing or slow`);
		if (p.phase === "existing") {
			for (const [key, max] of Object.entries({
				firstMs: 200,
				projectionMs: 10000 * scale,
				verify100Ms: 2000,
			})) {
				if (!p.archived || !Number.isFinite(p.archived[key]) || p.archived[key] > max)
					failures.push(`${p.phase}.archived.${key} exceeds ${max}`);
			}
		}
	}
	return failures;
}
