import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createCheckpoint, safeErrorMessage } from "./checkpoint.mjs";
import { desktopOverrides, withDesktop } from "./desktop.mjs";
import { validateRunOwner, validateWorkPath } from "./paths.mjs";

const PROFILES = { quick: { warmup: 1, rounds: 3 }, full: { warmup: 2, rounds: 5 } };
const BODY_SIZE = 4718592;
const PATTERN = "Synthetic output. ";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function largeTextFixture(cwd) {
	const body = PATTERN.repeat(Math.ceil(BODY_SIZE / PATTERN.length)).slice(0, BODY_SIZE);
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const timestamp = "2026-01-01T00:00:00.000Z";
	const entries = [
		{ type: "session", version: 3, id: "switch-diagnostic-large-turn", timestamp, cwd },
		{
			type: "message",
			id: "e0",
			parentId: null,
			timestamp,
			message: { timestamp: 1, role: "user", content: [{ type: "text", text: "Synthetic task 0" }] },
		},
		{
			type: "message",
			id: "e1",
			parentId: "e0",
			timestamp,
			message: {
				timestamp: 2,
				role: "assistant",
				content: [{ type: "text", text: body }],
				stopReason: "stop",
				usage,
				api: "openai-completions",
				provider: "synthetic",
				model: "synthetic",
			},
		},
	];
	return {
		body,
		bodyHash: sha(body),
		fixtureHash: sha(JSON.stringify({ schema: 1, body, user: "Synthetic task 0", role: "assistant" })),
		jsonl: `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	};
}
export function createLargeTextFixture(cwd) {
	return largeTextFixture(cwd).jsonl;
}
export async function runLargeText({ repo, runDir, profile, env = {}, signal, cleanupResults = [] }) {
	const config = PROFILES[profile];
	assert(config, "Unknown large-text profile");
	const root = validateWorkPath(repo, join(runDir, "work/large-text"));
	assert.equal(env.PERCHO_PERF_RUN_DIR, runDir, "Performance run directory mismatch");
	validateRunOwner(repo, runDir, env.PERCHO_PERF_OWNER);
	const file = join(root, "fixtures/original.jsonl");
	const cwd = join(root, "project");
	await mkdir(cwd, { recursive: true, mode: 0o700 });
	await mkdir(dirname(file), { mode: 0o700 });
	const fixture = largeTextFixture(cwd);
	await writeFile(file, fixture.jsonl, { flag: "wx", mode: 0o600 });
	const rawFile = join(runDir, "raw/large-text.json");
	const records = [];
	let viewport,
		current,
		stopped = false;
	const checkpoint = createCheckpoint(rawFile);
	const save = async (status, error) => {
		const data = {
			version: 2,
			status,
			profile,
			viewport,
			fixtureHash: fixture.fixtureHash,
			bodyHash: fixture.bodyHash,
			bodyCharacters: fixture.body.length,
			samples: records,
			...(error ? { error: safeErrorMessage(error) } : {}),
		};
		await checkpoint.save(data);
	};
	await save("running");
	try {
		await withDesktop(
			{
				repo,
				directory: join(root, "host-run"),
				kind: "large-text",
				env: desktopOverrides(env),
				signal,
				cleanupResults,
			},
			async (host) => {
				if (!cleanupResults.includes(host.cleanupResult)) cleanupResults.push(host.cleanupResult);
				const { renderer, main, moduleFile } = host;
				await renderer.eval(
					`(async()=>{window.__perfLargeText=await import(${JSON.stringify(moduleFile)});return true})()`,
				);
				await renderer.eval(
					"window.__perfLargeText.diagPrefs.setState({sessionRailEnabled:true,autoEvaporateToolResults:false});window.__perfLargeText.diagUi.setState({activeTab:'chat',settingsTab:null});window.resizeTo(1440,960);true",
				);
				await renderer.eval("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
				viewport = await renderer.eval("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})");
				for (let index = 0; index < config.warmup + config.rounds; index++) {
					signal?.throwIfAborted();
					await renderer.eval(
						`(()=>{window.__perfLargeOpen=null;(async()=>{const m=window.__perfLargeText,s=m.diagSessions.getState();s.activateNewSessionDraft();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const t=performance.now(),opened=await m.diagSessions.getState().openFromHistory(${JSON.stringify(file)});if(!opened?.latest)throw new Error('openFromHistory superseded');const navigation=performance.now()-t,id=opened.meta.sessionId;while(!m.diagHistoryReady(id)||document.querySelector('[data-session-page]')?.dataset.sessionId!==id||!document.querySelector('[contenteditable=true]')){if(performance.now()-t>15000)throw new Error('History and editable composer not ready');await new Promise(r=>setTimeout(r,20));}const ready=performance.now()-t;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {id,navigation,ready,firstPaint:performance.now()-t,elements:document.querySelectorAll('*').length}})().then(value=>window.__perfLargeOpen={value},error=>window.__perfLargeOpen={error:String(error)});return true})()`,
					);
					let opened;
					const openingDeadline = Date.now() + 20000;
					while (Date.now() < openingDeadline) {
						signal?.throwIfAborted();
						opened = await renderer.eval("window.__perfLargeOpen");
						if (opened) break;
						// Only this empty, owned project is in the fixture. Decline its trust request.
						await renderer.eval(
							"(()=>{const b=[...document.querySelectorAll('button')].find(b=>/不信任|Don't trust/.test(b.textContent??''));b?.click();return !!b})()",
						);
						await pause(50);
					}
					assert(opened, "Opening the isolated history timed out");
					assert(!opened.error, opened.error);
					const row = opened.value;
					signal?.throwIfAborted();
					if (stopped) throw new Error("Collection stopped");
					current = { ...row, warmup: index < config.warmup, status: "validating" };
					records.push(current);
					await save("running");
					const persisted = await main.eval(
						`globalThis.__perfBackend().getSessionMessages(${JSON.stringify(row.id)},{imageMode:'references'})`,
					);
					const text = persisted.find((message) => message.role === "assistant")?.text;
					assert.equal(text?.length, fixture.body.length, "Full stored text must remain available");
					assert.equal(sha(text), fixture.bodyHash, "Stored text changed while rendering");
					const visual = await renderer.eval(
						"(()=>{const e=[...document.querySelectorAll('[data-session-page] .markdown-body')].find(e=>(e.textContent?.length??0)>1000000);if(!e)return null;const s=getComputedStyle(e),r=e.getBoundingClientRect();return {text:e.textContent,visible:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0,unclipped:e.scrollHeight<=e.clientHeight+2}})()",
					);
					assert(
						visual?.visible && visual.unclipped,
						"Full visible body must not be replaced by a clipped preview",
					);
					assert.equal(
						sha(visual.text.trim()),
						sha(fixture.body.trim()),
						"Rendered body must retain the full original text",
					);
					await renderer.eval(
						`(async()=>{const m=window.__perfLargeText;m.diagSessions.getState().activateNewSessionDraft();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const closed=await m.diagSessions.getState().closeSession(${JSON.stringify(row.id)},'gc');if(!closed.closed)throw new Error('GC refused');return true})()`,
					);
					let stats;
					const until = Date.now() + 15000;
					do {
						stats = await host.backendStats();
						if (stats.views === 0) break;
						assert(Date.now() < until, "GC retained views");
						await pause(20);
					} while (Date.now() < until);
					assert.equal(stats?.views, 0, "GC retained views");
					signal?.throwIfAborted();
					if (stopped) throw new Error("Collection stopped");
					Object.assign(current, { views: stats.views, status: "passed" });
					current = undefined;
					await save("running");
				}
			},
		);
		await save("passed");
	} catch (error) {
		stopped = true;
		if (current)
			Object.assign(current, {
				status: signal?.aborted ? "interrupted" : "failed",
				error: safeErrorMessage(error),
			});
		await save(signal?.aborted ? "interrupted" : "failed", error);
		throw error;
	}
	const measured = records.filter((record) => !record.warmup && record.status === "passed");
	const metrics = [];
	for (const key of ["navigation", "firstPaint", "ready"]) {
		const values = measured.map((record) => record[key]).sort((a, b) => a - b);
		for (const [name, p] of [
			["median", 0.5],
			["p95", 0.95],
		])
			metrics.push({
				name: `${key}.${name}`,
				value: values[Math.min(values.length - 1, Math.floor(values.length * p))],
				unit: "ms",
				lowerIsBetter: true,
			});
	}
	metrics.push({
		name: "maxElements",
		value: Math.max(...measured.map((record) => record.elements)),
		unit: "count",
		lowerIsBetter: true,
	});
	return {
		status: "passed",
		contract: {
			version: 2,
			mode: "built-renderer",
			fixtureHash: fixture.fixtureHash,
			measurementHash: sha(await readFile(new URL(import.meta.url))),
			parameters: { ...config, bodyCharacters: BODY_SIZE, lifecycle: "newDraft-gc-close-zero-views-reopen" },
			viewport,
		},
		metrics,
		rawFiles: [relative(runDir, rawFile)],
		notes: [
			"Unprofiled timings after authoritative history, mounted page, editable composer and two rAFs; not OS presentation. All warmups retained. Small-sample p95 is the maximum, not a tail-latency guarantee. Full source text/hash are verified, not truncated.",
		],
	};
}
