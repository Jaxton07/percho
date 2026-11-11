import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { summarize } from "../report-conversation-minimap.mjs";
import { desktopOverrides, withDesktop } from "./desktop.mjs";
import { runLargeText } from "./large-text.mjs";
import { measurementFingerprint } from "./measurement.mjs";
import { summarizeRenderingRuns } from "./rendering-report.mjs";

export const SUITES = ["minimap", "rendering", "large-text", "switch", "images", "catalog"];
export const defaults = (profile) =>
	profile === "full" ? [...SUITES] : ["minimap", "large-text", "catalog"];
export const metric = (name, value, unit = "ms", lowerIsBetter = true) => ({
	name,
	value,
	unit,
	lowerIsBetter,
});
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
async function hash(repo, files) {
	const hash = createHash("sha256");
	for (const file of files) hash.update(file).update(await readFile(join(repo, file)));
	return hash.digest("hex");
}
function result(contract, metrics, rawFiles, notes = []) {
	assert(
		metrics.every((point) => Number.isFinite(point.value)),
		"Non-finite performance metric",
	);
	return { status: "passed", contract, metrics, rawFiles, notes };
}
async function rawCopy(context, source, name) {
	const target = join(context.runDir, "raw", name);
	await writeFile(target, await readFile(source), { flag: "wx", mode: 0o600 });
	return relative(context.runDir, target);
}
function rememberCleanup(context, host) {
	if (!context.cleanupResults.includes(host.cleanupResult)) context.cleanupResults.push(host.cleanupResult);
}
async function minimap(context) {
	const { repo, runDir, profile, env, runCommand, signal } = context;
	const full = profile === "full";
	const parameters = {
		turns: full ? [20, 120, 1000] : [20, 120],
		rounds: full ? 3 : 1,
		switches: full ? 30 : 5,
		launches: full ? 3 : 1,
	};
	const directory = join(runDir, "work/minimap");
	await mkdir(directory, { mode: 0o700 });
	const files = [],
		reports = [];
	let viewport;
	for (let n = 1; n <= parameters.launches; n++) {
		await withDesktop(
			{
				repo,
				directory: join(directory, `launch-${n}`),
				kind: "minimap",
				env: desktopOverrides(env),
				signal,
				cleanupResults: context.cleanupResults,
			},
			async (host) => {
				rememberCleanup(context, host);
				await runCommand(
					[
						"scripts/check-conversation-minimap.mjs",
						`--task=${join(directory, `launch-${n}`)}`,
						`--owner=${host.owner}`,
						`--source=${repo}`,
						`--cdp=${host.cdpPort}`,
						`--inspect=${host.inspectPort}`,
						`--rounds=${parameters.rounds}`,
						`--switches=${parameters.switches}`,
						`--turns=${parameters.turns.join(",")}`,
						`--module=${host.moduleFile}`,
					],
					{ log: `minimap-${n}.log`, env: host.env },
				);
				const report = await json(join(directory, `launch-${n}/minimap-results.json`));
				assert.equal(report.mode, "built-renderer");
				if (viewport)
					assert.deepEqual(report.window, viewport, "Viewport changed between independent launches");
				viewport = report.window;
				reports.push(report);
				files.push(
					await rawCopy(context, join(directory, `launch-${n}/minimap-results.json`), `minimap-${n}.json`),
				);
			},
		);
	}
	const metrics = [];
	for (const row of summarize(reports)) {
		for (const key of ["medianMs", "p95Ms", "frameP95Ms", "inputP95Ms"])
			if (row[key] != null) metrics.push(metric(`${row.name}.${key}`, row[key]));
		for (const key of ["longTasks", "maxRows", "maxRailMounted"])
			metrics.push(metric(`${row.name}.${key}`, row[key], "count"));
	}
	return result(
		{
			version: 1,
			mode: "built-renderer",
			fixtureHash: await hash(repo, [
				"scripts/check-conversation-minimap.mjs",
				"scripts/fixtures/conversation-minimap.mjs",
				"scripts/report-conversation-minimap.mjs",
			]),
			parameters,
			viewport,
		},
		metrics,
		files,
		[
			"Input timings include CDP and two rAFs, not pure editor processing or OS presentation. Synthetic streaming excludes model/tool/network generation.",
		],
	);
}
async function rendering(context) {
	const { repo, runDir, profile, env, runCommand, signal } = context;
	const directory = join(runDir, "work/rendering");
	const all = [],
		files = [];
	await mkdir(directory, { mode: 0o700 });
	const modes =
		profile === "full"
			? [
					["performance", ["--after"]],
					["interactions", ["--after", "--interactions-only", "--resources"]],
				]
			: [["smoke", ["--after", "--smoke"]]];
	for (const [label, args] of modes) {
		const modeDirectory = join(directory, label);
		await withDesktop(
			{
				repo,
				directory: modeDirectory,
				kind: "rendering",
				env: desktopOverrides(env),
				signal,
				cleanupResults: context.cleanupResults,
			},
			async (host) => {
				rememberCleanup(context, host);
				const childEnv = {
					...host.env,
					PERCHO_RENDERING_ROOT: modeDirectory,
					PERCHO_CDP_PORT: String(host.cdpPort),
					PERCHO_INSPECT_PORT: String(host.inspectPort),
					PERCHO_RENDERING_PID: String(host.pid),
					PERCHO_RENDERING_MODULE: host.moduleFile,
				};
				await runCommand(["scripts/check-session-rendering.mjs", label, "--production", ...args], {
					log: `rendering-${label}.log`,
					env: childEnv,
				});
				const report = await json(join(modeDirectory, `${label}.json`));
				all.push({ label, report });
				files.push(await rawCopy(context, join(modeDirectory, `${label}.json`), `rendering-${label}.json`));
			},
		);
	}
	const { metrics, viewport } = summarizeRenderingRuns(all);
	return result(
		{
			version: 1,
			mode: "built-renderer",
			fixtureHash: await hash(repo, [
				"scripts/check-session-rendering.mjs",
				"scripts/session-rendering-fixture.mjs",
				"scripts/session-rendering-interactions.mjs",
				"scripts/session-rendering-sweep-probe.mjs",
			]),
			measurementHash: await hash(repo, ["scripts/performance/rendering-report.mjs"]),
			parameters: { profile, modes: all.map((item) => item.label) },
			viewport,
		},
		metrics,
		files,
		[
			"Full mode includes live interaction/resource assertions; quick mode is only a smoke sample. Independent scenarios are not pooled into one p95.",
		],
	);
}
async function ensureSwitchFixtures(context) {
	const root = join(context.runDir, "work/switch");
	try {
		await readFile(join(root, "manifest.json"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		await context.runCommand(["scripts/session-switch-fixtures.mjs"], {
			log: "switch-fixtures.log",
			env: { ...context.env, PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT: root },
		});
	}
	return root;
}
async function switchSuite(context, images = false) {
	const { repo, runDir, profile, env, runCommand, signal } = context;
	const kind = images ? "images" : "switch";
	const root = await ensureSwitchFixtures(context);
	const reportFile = join(runDir, "raw", images ? "images.json" : "switch.json");
	const imageSource =
		images && (await json(join(root, "manifest.json"))).find((fixture) => fixture.name === "screenshots");
	assert(!images || imageSource, "Screenshot fixture missing");
	// Capture before launching Electron, including any automatic initial history open.
	const before = images ? await readFile(imageSource.file) : null;
	let viewport;
	await withDesktop(
		{
			repo,
			directory: join(runDir, "work", `${kind}-host`),
			mode: "dev",
			kind,
			env: { ...desktopOverrides(env), PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT: root },
			signal,
			cleanupResults: context.cleanupResults,
		},
		async (host) => {
			rememberCleanup(context, host);
			await host.renderer.eval("window.resizeTo(1440,960);true");
			await host.renderer.eval("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
			viewport = await host.renderer.eval("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})");
			const childEnv = {
				...host.env,
				PERCHO_CDP_PORT: String(host.cdpPort),
				PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT: root,
				PERCHO_SESSION_SWITCH_REPORT_FILE: reportFile,
			};
			if (images) {
				// The full switch suite normally initializes SDK configuration entries first.
				// Do that explicitly for standalone image acceptance, keeping its byte-invariance assertion strict.
				await host.renderer.eval(`(async () => {
					const m = await import('/src/stores/sessions.ts');
					const fixtures = await window.pi.getSessionSwitchFixtures();
					const source = fixtures.find(f => f.name === 'screenshots');
					if (!source) throw new Error('Screenshot fixture missing');
					const opened = await m.useSessionsStore.getState().openFromHistory(source.file);
					if (!opened?.latest) throw new Error('Fixture initialization superseded');
					m.useSessionsStore.getState().activateNewSessionDraft();
					await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
					const closed = await m.useSessionsStore.getState().closeSession(opened.meta.sessionId, 'gc');
					if (!closed.closed) throw new Error('Fixture initialization GC refused');
					return true;
				})()`);
				const after = await readFile(imageSource.file);
				assert(
					after.subarray(0, before.length).equals(before),
					"SDK initialization rewrote original fixture data",
				);
				const appended = after.subarray(before.length).toString("utf8").trim();
				if (appended)
					assert(
						appended
							.split("\n")
							.map((line) => JSON.parse(line))
							.every((entry) => ["thinking_level_change", "model_change"].includes(entry.type)),
						"Unexpected SDK fixture initialization entries",
					);
			}
			await runCommand([`scripts/check-session-switch-${images ? "images" : "diagnostics"}.mjs`], {
				log: `${kind}.log`,
				env: childEnv,
			});
			if (images) await rawCopy(context, join(root, "ticket03-images.json"), "images.json");
		},
	);
	const report = await json(reportFile);
	const metrics = [];
	if (!images)
		for (const group of report.summary) {
			for (const [key, value] of Object.entries(group.firstPaint))
				metrics.push(metric(`${group.fixture}.firstPaint.${key}`, value));
			for (const stage of group.stages)
				for (const key of ["p50", "p95"])
					metrics.push(metric(`${group.fixture}.${stage.stage}.${key}`, stage[key]));
		}
	return result(
		{
			version: 1,
			mode: "dev",
			fixtureHash: await hash(repo, [
				"scripts/session-switch-fixtures.mjs",
				`scripts/check-session-switch-${images ? "images" : "diagnostics"}.mjs`,
			]),
			parameters: {
				profile,
				recipe: images ? "six-image-formats" : "five-fixtures-30-gc-reopens",
				preparation: images ? "initialize-source-sdk-config-then-gc" : "none",
				build: report.build ?? "dev",
			},
			viewport,
		},
		metrics,
		[relative(runDir, reportFile)],
		images
			? [
					"Functional and resource assertions, not a latency budget. Six media formats; not native image clipboard or a packaged application.",
				]
			: [
					"These are dev GC reopens, not built hot switches. First paint includes authoritative history and two rAFs, not OS final presentation.",
				],
	);
}
async function catalog(context) {
	const { repo, runDir, profile, env, runCommand } = context;
	const counts = profile === "full" ? [1000, 10000] : [1000];
	const metrics = [],
		files = [];
	for (const count of counts) {
		const name = `catalog-${count}.json`;
		await runCommand(["scripts/bench-session-catalog.mjs", String(count)], {
			log: `catalog-${count}.log`,
			env: { ...env, PERCHO_CATALOG_REPORT_FILE: join(runDir, "raw", name) },
		});
		const report = await json(join(runDir, "raw", name));
		assert.deepEqual(report.budgetFailures, [], "Catalog regression budget failed");
		assert.equal(report.dataset.sessions, count);
		for (const phase of report.phases)
			for (const key of ["refreshTotalMs", "eventLoopDelayP99Ms", "peakRssBytes"]) {
				if (Number.isFinite(phase[key]))
					metrics.push(
						metric(`${count}.${phase.phase}.${key}`, phase[key], key === "peakRssBytes" ? "bytes" : "ms"),
					);
			}
		files.push(`raw/${name}`);
	}
	return result(
		{
			version: 1,
			mode: "node-worker",
			fixtureHash: await hash(repo, ["scripts/bench-session-catalog.mjs"]),
			parameters: { counts, cache: "fresh-process-not-cold-disk" },
		},
		metrics,
		files,
		["Existing local regression budgets are enforced; they are not an SLA."],
	);
}
export async function runSuite(name, context) {
	const runners = {
		minimap,
		rendering,
		switch: (ctx) => switchSuite(ctx),
		images: (ctx) => switchSuite(ctx, true),
		catalog,
		"large-text": runLargeText,
	};
	if (!Object.hasOwn(runners, name)) throw new Error(`Unknown performance suite: ${name}`);
	const runner = runners[name];
	const output = await runner(context);
	output.contract.measurementVersion = 2;
	output.contract.measurementHash = await measurementFingerprint(context.repo);
	if (name !== "catalog") {
		output.contract.harnessHash = await hash(context.repo, ["scripts/performance/desktop.mjs"]);
		output.contract.runtimePolicy = "private-agent-project-trust-never";
	}
	return output;
}
