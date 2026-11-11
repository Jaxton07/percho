#!/usr/bin/env node
/**
 * Isolated CDP baseline; no models/tools are executed.
 * Preferred production reuse: node scripts/run-session-rendering.mjs baseline-prod
 * (prepare-session-rendering-host.mjs freezes an already-built diagnostic host first).
 * Supplement: node scripts/run-session-rendering.mjs baseline-interactions --interactions-only
 * Launch first (repository root):
 * PERCHO_AGENT_DIR=$PWD/.local/tmp/session-rendering-baseline/agent node scripts/dev-desktop.mjs \
 *   --remote-debugging-port=9244 --inspect=9245 \
 *   --user-data-dir=$PWD/.local/tmp/session-rendering-baseline/user-data
 * Run: node scripts/check-session-rendering.mjs [baseline|after]
 * Owns only this fixed agent/userData pair; inspector preflight is checked before any mutation.
 * Reports contain counters/timings only. Finally quits this Electron, not other instances.
 * Stream transport: main webContents.send -> real preload -> event bridge -> conflator -> store.
 * It excludes SDK event generation. Static mounting is a separately labelled local projection probe.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createCheckpoint } from "./performance/checkpoint.mjs";
import { suiteRoot } from "./performance/paths.mjs";
import { connect } from "./session-rendering-cdp.mjs";
import { renderingFixture, renderingSession } from "./session-rendering-fixture.mjs";
import { measureInteractions } from "./session-rendering-interactions.mjs";
import { installResourceProbe, readResources, removeResourceProbe } from "./session-rendering-resources.mjs";
import { verifyDiffViewState } from "./session-rendering-view-state.mjs";

const repo = resolve(import.meta.dirname, ".."),
	root = suiteRoot(repo, "rendering", ".local/tmp/session-rendering-baseline", "PERCHO_RENDERING_ROOT");
await mkdir(root, { recursive: true });
await mkdir(resolve(root, "project"), { recursive: true, mode: 0o700 });
assert.equal(await realpath(root), root, "No symlink diagnostic root");
for (const path of [root, resolve(root, "agent")]) {
	assert.equal(await realpath(path), path, "No symlink diagnostic directory");
	if (process.platform !== "win32")
		assert.equal((await stat(path)).mode & 0o077, 0, "Prepare private diagnostic directories before launch");
}
const label = process.argv[2] ?? "baseline";
const smoke = process.argv.includes("--smoke");
const short = process.argv.includes("--short");
const production = process.argv.includes("--production");
const after = process.argv.includes("--after");
const interactionsOnly = process.argv.includes("--interactions-only");
const viewOnly = process.argv.includes("--view-only");
const resources = process.argv.includes("--resources");
const host = resolve(root, after ? "frozen-after-host" : "frozen-host");
const moduleFile = production
	? (process.env.PERCHO_RENDERING_MODULE ??
		JSON.parse(
			await readFile(
				resolve(root, after ? "production-module-after.json" : "production-module.json"),
				"utf8",
			),
		).file)
	: null;
if (production)
	assert((await realpath(moduleFile)).startsWith(`${process.env.PERCHO_RENDERING_MODULE ? root : host}/`));
const toolCount = smoke || short ? 80 : 2600;
assert.match(label, /^[a-z-]+$/);
const checkpoint = createCheckpoint(resolve(root, `${label}-checkpoint.json`));
await build({
	stdin: {
		contents: 'export { IpcChannels } from "./packages/shared/src/ipc-channels.ts";',
		resolveDir: repo,
	},
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: resolve(root, "contract.mjs"),
	logLevel: "silent",
});
const { IpcChannels } = await import(pathToFileURL(resolve(root, "contract.mjs")));

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const renderer = await connect(Number(process.env.PERCHO_CDP_PORT ?? 9244)),
	main = await connect(Number(process.env.PERCHO_INSPECT_PORT ?? 9245));
let owned = false;
const samples = [];
try {
	const identity = await main.eval(
		`({pid:process.pid,agent:process.env.PI_CODING_AGENT_DIR,userData:process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').app.getPath('userData'),appPath:process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').app.getAppPath()})`,
	);
	assert.equal(identity.agent, resolve(root, "agent"));
	assert.equal(identity.userData, resolve(root, "user-data-dev"));
	if (process.env.PERCHO_RENDERING_PID ?? process.env.PERCHO_RENDERING_OWNER_PID)
		assert.equal(
			identity.pid,
			Number(process.env.PERCHO_RENDERING_PID ?? process.env.PERCHO_RENDERING_OWNER_PID),
			"CDP does not belong to the launched child",
		);
	if (production)
		assert.equal(identity.appPath, process.env.PERCHO_RENDERING_MODULE ? resolve(root, "host") : host);
	owned = true;
	await renderer.send("Emulation.setFocusEmulationEnabled", { enabled: true });
	await renderer.send("Performance.enable");
	const readyUntil = Date.now() + 30000;
	while (
		!(await renderer.eval(
			"document.documentElement.dataset.appReady === 'true' && !document.querySelector('#splash')",
		))
	) {
		const startup = await renderer.eval("window.pi?.storageStartupGet().catch(()=>null)");
		if (startup?.phase === "error") throw new Error(`Isolated startup failed: ${startup.error}`);
		if (startup?.phase === "choice" || startup?.phase === "existing")
			await renderer.eval(
				`window.pi.storageStartupAct({action:${JSON.stringify(startup.phase === "existing" ? "adopt" : "empty")}})`,
			);
		if (Date.now() > readyUntil) throw new Error("Workbench startup timeout");
		await pause(100);
	}
	await renderer.eval(`(async()=>{
		const [{useSessionsStore:sessions},{useTranscriptStore:transcripts},{useUiStore:ui},{useUiPreferencesStore:prefs},core,{getExecutionApi}]=await ${production ? `import(${JSON.stringify(pathToFileURL(moduleFile).href)}).then(m=>[{useSessionsStore:m.diagSessions},{useTranscriptStore:m.diagTranscripts},{useUiStore:m.diagUi},{useUiPreferencesStore:m.diagPrefs},{emptyTranscript:m.diagEmpty,reduceEvent:m.diagReduce,views:m.diagViews},{getExecutionApi:m.diagApi}])` : `Promise.all([import('/src/stores/sessions.ts'),import('/src/stores/transcript.ts'),import('/src/stores/ui.ts'),import('/src/stores/ui-preferences.ts'),import('/@fs${repo}/packages/shared/src/transcript/index.ts'),import('/src/environment-api.ts')])`};
		window.__renderDiag={sessions,transcripts,ui,prefs,core,getExecutionApi};
		window.__renderDiag.received=0;
		window.__renderDiag.off=window.pi.forEnvironment({kind:'local'}).onEvent(()=>{window.__renderDiag.received++});
		prefs.setState({centerOrbEnabled:true,sidebarCollapsed:false});
		window.resizeTo(1280,900);
	})()`);
	const events = renderingFixture(toolCount);
	const historyFile = resolve(root, "agent/sessions/rendering-history.jsonl");
	await mkdir(resolve(root, "agent/sessions"), { recursive: true, mode: 0o700 });
	await writeFile(historyFile, renderingSession(events, resolve(root, "project")), { mode: 0o600 });
	const expected = await renderer.eval(
		`(()=>{const d=window.__renderDiag; d.events=${JSON.stringify(events)}; d.expected=d.events.reduce(d.core.reduceEvent,d.core.emptyTranscript());d.summary=s=>({messages:s.messages.length,tools:s.messages.flatMap(m=>m.tools??[]).map(t=>[t.id,t.name,t.args.length,t.output.length,t.state]),compactions:s.messages.filter(m=>m.compact?.status==='done').length,active:s.agentActive,streaming:!!s.streaming}); return d.summary(d.expected);})()`,
	);
	assert.equal(expected.tools.length, toolCount);
	const snapshot = async (stage, round, timing) => {
		// Timing stops before observer RPCs and checkpoint I/O. Persist it even if those probes fail.
		const timedSample = timing ? { stage, round, ...timing } : null;
		if (timedSample) {
			samples.push(timedSample);
			await checkpoint.save({ label, samples });
		}
		const processes = await main.eval(
			"process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').app.getAppMetrics().map(p=>({type:p.type,memory:p.memory}))",
		);
		const dom = await renderer.send("Memory.getDOMCounters");
		const metrics = await renderer.send("Performance.getMetrics");
		const state = await renderer.eval(
			`(()=>{const d=window.__renderDiag,s=d.transcripts.getState().bySession[d.sid]??d.core.emptyTranscript();return {messages:s.messages.length,tools:s.messages.reduce((n,m)=>n+(m.tools?.length??0),0),elements:document.querySelectorAll('*').length,diffLines:document.querySelectorAll('.diff-line').length,toolCards:document.querySelectorAll("details[class*='group/dets']").length,frames:d.frames.splice(0),longTasks:d.longTasks.splice(0),inputs:d.inputs.splice(0),dpr:devicePixelRatio,width:innerWidth,height:innerHeight,hidden:document.hidden};})()`,
		);
		const sample = {
			stage,
			round,
			...state,
			dom,
			metrics: Object.fromEntries(
				metrics.metrics
					.filter((m) =>
						[
							"JSHeapUsedSize",
							"JSHeapTotalSize",
							"LayoutCount",
							"RecalcStyleCount",
							"TaskDuration",
							"LayoutDuration",
						].includes(m.name),
					)
					.map((m) => [m.name, m.value]),
			),
			processes,
		};
		if (timedSample) Object.assign(timedSample, sample);
		else samples.push(sample);
		await checkpoint.save({ label, samples });
		console.log(
			JSON.stringify({
				stage,
				round,
				messages: state.messages,
				tools: state.tools,
				elements: state.elements,
				diffLines: state.diffLines,
			}),
		);
		return samples.at(-1);
	};
	for (let round = 0; round < (interactionsOnly || viewOnly ? 0 : smoke ? 1 : 3); round++) {
		await renderer.eval(
			`(()=>{const d=__renderDiag;d.pendingCreate=null;d.getExecutionApi({kind:'local'}).createSession({options:{cwd:${JSON.stringify(resolve(root, "project"))}}}).then(meta=>{d.meta=meta;d.pendingCreate={sid:meta.sessionId}},error=>d.pendingCreate={error:String(error)});return true})()`,
		);
		let created;
		const createUntil = Date.now() + 30000;
		while (Date.now() < createUntil) {
			created = await renderer.eval("__renderDiag.pendingCreate");
			if (created) break;
			if (process.env.PERCHO_PERF_RUN_DIR)
				await renderer.eval(
					"(()=>{const b=[...document.querySelectorAll('button')].find(b=>/不信任|Don't trust/.test(b.textContent??''));b?.click();return !!b})()",
				);
			await pause(50);
		}
		assert(created && !created.error, created?.error ?? "Isolated session creation timed out");
		const sid = created.sid;
		await renderer.eval(
			`(()=>{const d=window.__renderDiag;d.observer?.disconnect();cancelAnimationFrame(d.raf);clearInterval(d.interact);d.sid=${JSON.stringify(sid)};d.transcripts.getState().resetSession(d.sid);d.sessions.setState({sessions:[d.meta],activeSessionId:d.sid,newSessionDraft:null});d.frames=[];d.longTasks=[];d.inputs=[];d.last=0;d.observer=new PerformanceObserver(list=>{for(const e of list.getEntries())d.longTasks.push(e.duration)});d.observer.observe({entryTypes:['longtask']});const tick=t=>{if(d.last)d.frames.push(t-d.last);d.last=t;d.raf=requestAnimationFrame(tick)};d.raf=requestAnimationFrame(tick);})()`,
		);
		await renderer.eval("__renderDiag.transcripts.getState().loadHistory(__renderDiag.sid,[])");
		await renderer.eval("__renderDiag.received=0");
		await pause(100);
		await snapshot("empty", round);
		await main.eval(
			`(()=>{const electron=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');globalThis.__renderReplay={events:${JSON.stringify(events)},index:0,win:electron.BrowserWindow.getAllWindows()[0],sid:${JSON.stringify(sid)},started:Date.now()};})()`,
		);
		// Each ramp remains in the same loaded session; representative 50/s samples follow 500/s growth.
		const size = events.length;
		for (let part = 1; part <= 4; part++) {
			const target = part === 4 ? size : Math.floor((size * part) / 4);
			let sent = await main.eval("__renderReplay.index");
			while (sent < target) {
				const next = Math.min(sent + 100, target);
				await main.eval(
					`(()=>{const d=globalThis.__renderReplay;clearInterval(d.timer);d.target=${next};d.timer=setInterval(()=>{for(let n=0;n<5&&d.index<d.target;n++){d.win.webContents.send(${JSON.stringify(IpcChannels.Event)},{sessionId:d.sid,event:d.events[d.index++]});}if(d.index>=d.target)clearInterval(d.timer)},10);return true})()`,
				);
				const until = Date.now() + 120000;
				while ((await renderer.eval("__renderDiag.received")) < next) {
					if (Date.now() > until) throw new Error("Renderer drain timeout");
					await pause(100);
				}
				sent = next;
			}
			await pause(100);
			await snapshot(`growth-${part}`, round);
			if (part < 4) {
				const stageStart = performance.now();
				const slowTarget = Math.min(target + 150, size);
				await main.eval(
					`(()=>{const d=__renderReplay;d.target=${slowTarget};d.timer=setInterval(()=>{if(d.index<d.target)d.win.webContents.send(${JSON.stringify(IpcChannels.Event)},{sessionId:d.sid,event:d.events[d.index++]});if(d.index>=d.target)clearInterval(d.timer)},20);return true})()`,
				);
				await renderer
					.eval("window.__renderDiag.prefs.getState().toggleSidebar()")
					.catch(() =>
						renderer.eval(
							"window.__renderDiag.prefs.setState({sidebarCollapsed:!window.__renderDiag.prefs.getState().sidebarCollapsed})",
						),
					);
				await renderer.eval("document.querySelector('[contenteditable=true]')?.focus()");
				for (let input = 0; input < (after ? 10 : 1); input++) {
					const start = performance.now();
					await renderer.send("Input.insertText", { text: "probe" });
					await renderer.eval("new Promise(r=>requestAnimationFrame(()=>r(true)))");
					await renderer.eval(`window.__renderDiag.inputs.push(${performance.now() - start})`);
					if (after) await pause(100);
				}
				await pause(Math.max(0, 3300 - (performance.now() - stageStart)));
				await snapshot(`steady-50-${part}`, round);
			}
		}
		const actual = await renderer.eval(
			"__renderDiag.summary(__renderDiag.transcripts.getState().bySession[__renderDiag.sid])",
		);
		assert.deepEqual(actual, expected, "IPC conflation must preserve projection");
		await renderer.eval("__renderDiag.ui.getState().setDiffSidebarOpen(true)");
		await pause(500);
		await snapshot("diff-open", round);
		await renderer.eval("__renderDiag.ui.getState().setDiffSidebarOpen(false)");
		await pause(500);
		await snapshot("diff-closed", round);
		// Local projection/mount cost is explicitly separate from the IPC stream samples.
		await renderer.eval("__renderDiag.sessions.getState().activateNewSessionDraft()");
		await pause(100);
		const start = performance.now();
		await renderer.eval(
			"(()=>{const d=__renderDiag;d.transcripts.getState().loadHistory(d.sid,d.expected.messages);d.sessions.setState({activeSessionId:d.sid,newSessionDraft:null});return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))})()",
		);
		await snapshot("local-history-mount", round, { mountRoundTripMs: performance.now() - start });
		await renderer.eval(
			"(async()=>{const d=__renderDiag;d.sessions.getState().activateNewSessionDraft();await d.sessions.getState().closeSession(d.sid);})()",
		);
	}
	// Independently exercise the actual backend history/open/baseline path, including existing paging.
	for (let round = 0; round < (smoke ? 1 : 3); round++) {
		await renderer.eval(
			"(()=>{const d=__renderDiag;d.frames=[];d.longTasks=[];d.inputs=[];d.last=0;d.observer?.disconnect();cancelAnimationFrame(d.raf);d.observer=new PerformanceObserver(list=>{for(const e of list.getEntries())d.longTasks.push(e.duration)});d.observer.observe({entryTypes:['longtask']});const tick=t=>{if(d.last)d.frames.push(t-d.last);d.last=t;d.raf=requestAnimationFrame(tick)};d.raf=requestAnimationFrame(tick)})()",
		);
		const start = performance.now();
		await renderer.eval(
			`(async()=>{const d=__renderDiag;const result=await d.sessions.getState().openFromHistory(${JSON.stringify(historyFile)});if(!result.ok)throw new Error('Synthetic history open failed');d.sid=result.meta.sessionId;return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))})()`,
		);
		await snapshot("backend-history-open", round, { openRoundTripMs: performance.now() - start });
		if (resources) await installResourceProbe(renderer);
		if (viewOnly) {
			await renderer.eval(
				"__renderDiag.transcripts.getState().loadHistory(__renderDiag.sid,__renderDiag.expected.messages)",
			);
			await verifyDiffViewState(renderer, snapshot, round);
		}
		if (interactionsOnly)
			await measureInteractions(renderer, snapshot, round, {
				main,
				channel: IpcChannels.Event,
				after,
				resources,
			});
		await renderer.eval(
			"(async()=>{const d=__renderDiag;d.sessions.getState().activateNewSessionDraft();await d.sessions.getState().closeSession(d.sid)})()",
		);
		if (resources) {
			const counters = await readResources(renderer);
			await removeResourceProbe(renderer);
			await renderer.eval(
				"delete __renderDiag.bigGroup;delete __renderDiag.events;delete __renderDiag.expected",
			);
			await renderer.send("HeapProfiler.collectGarbage");
			const released = await snapshot("session-released-gc-probe", round);
			released.resources = counters;
			released.viewReleased = await renderer.eval(
				"!__renderDiag.core.views.getState().bySession[__renderDiag.sid]",
			);
			assert(released.viewReleased, "Closed sessions must release light view state");
		}
	}
	const report = {
		version: 1,
		label,
		smoke,
		buildMode: production ? "frozen-production" : "dev",
		synthetic: true,
		transport: "main IPC through preload/event bridge; no SDK generation",
		localHistoryProbe: "renderer projection/mount only, separate from backend-history-open",
		inputMetric: "CDP insertText round trip to next rAF, not OS presentation",
		growthSchedule:
			"100-event bursts at 500/s, renderer-drain backpressure; construction samples, not a fixed-rate throughput comparison",
		steadySchedule: "150 events at fixed 50/s per stage; primary streaming latency/frame comparator",
		eventCount: events.length,
		samples,
	};
	await writeFile(resolve(root, `${label}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
} finally {
	if (owned) {
		await main.eval("clearInterval(globalThis.__renderReplay?.timer)").catch(() => {});
		await main
			.eval(
				"(()=>{const {app}=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');setTimeout(()=>app.exit(0),2000);setTimeout(()=>app.quit(),200);return true})()",
			)
			.catch(() => {});
		await renderer
			.eval(
				"(()=>{const d=window.__renderDiag;if(d){d.off?.();d.observer?.disconnect();cancelAnimationFrame(d.raf);clearInterval(d.interact)}})()",
			)
			.catch(() => {});
	}
	renderer.close();
	main.close();
}
