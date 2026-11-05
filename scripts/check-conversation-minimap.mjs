#!/usr/bin/env node
// Isolated dev/built-renderer collector; it never launches or owns Electron (see --help).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFixtures } from "./fixtures/conversation-minimap.mjs";
import { connect } from "./session-rendering-cdp.mjs";

const help = `Dev-only collector, NOT a packaged-build or final acceptance test.
Start your own isolated dev Electron with a unique MINIMAP_OWNER token in its environment,
PERCHO_AGENT_DIR=<task>/agent, --user-data-dir=<task>/user-data, and distinct
--remote-debugging-port and --inspect ports. Stop that process yourself afterwards.
<task> must be an existing directory inside this checkout's .local/tmp; use an empty,
dedicated directory and no real project or extensions. The app must be ready and idle.
node scripts/check-conversation-minimap.mjs --task=<task> --owner=<token>
  [--source=<checkout>] [--cdp=9224] [--inspect=9225]
  [--rounds=3] [--switches=30] [--turns=20,120,1000] [--module=<diagnostic JS>]
The source must match the Electron cwd. Output is <task>/minimap-results.json.
--module uses a copied, built renderer inside this task, never release artifacts; it must
export diagSessions/diagTranscripts/diagReload/diagPrefs/diagUi. The copied host must own
the running file:// page. Omit it for the source dev server.
Run once per independent launch; compare same machine, window and build mode.
The collector opens synthetic histories and rejects extension trust, modifies the isolated
app state, and sends synthetic events. It does not terminate the externally owned app.
`;
if (process.argv.includes("--help")) {
	console.log(help);
	process.exit(0);
}

export function parseOptions(args) {
	const allowed = new Set([
		"task",
		"owner",
		"source",
		"cdp",
		"inspect",
		"rounds",
		"switches",
		"turns",
		"module",
	]);
	const values = {};
	for (const arg of args) {
		const match = /^--([a-z]+)=(.+)$/.exec(arg);
		if (!match || !allowed.has(match[1]) || values[match[1]] !== undefined) throw new Error("Invalid option");
		values[match[1]] = match[2];
	}
	const integer = (value, min, max) => {
		if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
			throw new Error("Invalid numeric option");
		return Number(value);
	};
	if (!values.task || !values.owner || values.owner.length < 16)
		throw new Error("Task and owner token required");
	const turns = (values.turns ?? "20,120,1000").split(",").map((v) => integer(v, 1, 10000));
	if (new Set(turns).size !== turns.length || turns.length < 2)
		throw new Error("Specify distinct turn counts");
	const cdp = integer(values.cdp ?? "9224", 1024, 65535),
		inspect = integer(values.inspect ?? "9225", 1024, 65535);
	if (cdp === inspect) throw new Error("Ports must differ");
	return {
		...values,
		cdp,
		inspect,
		turns,
		rounds: integer(values.rounds ?? "3", 1, 100),
		switches: integer(values.switches ?? "30", 1, 1000),
	};
}

async function run() {
	const options = parseOptions(process.argv.slice(2));
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const tmp = await realpath(join(root, ".local/tmp"));
	const task = await realpath(options.task);
	assert(task.startsWith(tmp + sep), "Task must be inside isolated temporary root");
	const source = await realpath(options.source ?? root);
	const moduleFile = options.module ? await realpath(options.module) : null;
	if (moduleFile) assert(moduleFile.startsWith(task + sep), "Diagnostic module must belong to task");
	const project = join(task, "project"),
		fixtures = join(task, "fixtures");
	// Refuse pre-existing project contents, including symlinks and extensions.
	await mkdir(project, { mode: 0o700 });
	await mkdir(fixtures, { mode: 0o700 });
	await writeFixtures(fixtures, project, options.turns);
	let renderer,
		main,
		verified = false;
	const samples = [];
	let phase = "connect";
	const pause = (ms) => new Promise((r) => setTimeout(r, ms));
	const wait = async (fn, timeout = 30000) => {
		const end = Date.now() + timeout;
		while (Date.now() < end) {
			if (await fn()) return;
			await pause(50);
		}
		throw new Error(`Timed out waiting for isolated app: ${phase}`);
	};
	const frame = () =>
		renderer.eval("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
	const cleanup = async () => {
		if (verified) {
			await main
				.eval(
					"(()=>{const s=globalThis.__minimapStream;if(s){clearInterval(s.timer);delete globalThis.__minimapStream}return true})()",
				)
				.catch(() => {});
			await renderer
				.eval(
					"(()=>{const d=window.__minimap;if(d){cancelAnimationFrame(d.raf);d.observer?.disconnect();delete window.__minimap}return true})()",
				)
				.catch(() => {});
		}
		renderer?.close();
		main?.close();
	};
	const stop = () => {
		void cleanup().finally(() => process.exit(130));
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		main = await connect(options.inspect);
		const identity = await main.eval(
			`(()=>{const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');return {owner:process.env.MINIMAP_OWNER,agent:process.env.PI_CODING_AGENT_DIR,userData:e.app.getPath('userData'),appPath:e.app.getAppPath(),cwd:process.cwd(),args:process.argv,windows:e.BrowserWindow.getAllWindows().length}})()`,
		);
		assert.equal(identity.owner, options.owner);
		assert.equal(identity.agent, join(task, "agent"));
		assert.equal(identity.userData, join(task, "user-data-dev"));
		assert.equal(await realpath(identity.agent), identity.agent);
		assert.equal(await realpath(identity.userData), identity.userData);
		assert.equal(identity.cwd, join(source, "packages/desktop"));
		assert(identity.args.some((a) => a === `--remote-debugging-port=${options.cdp}`));
		assert.equal(identity.windows, 1);
		renderer = await connect(options.cdp);
		const evaluate = renderer.eval.bind(renderer);
		renderer.eval = (expression) =>
			evaluate(`(window.__minimapPending=Promise.resolve().then(()=>(${expression})))`);
		const nonce = randomBytes(24).toString("hex");
		await main.eval(
			`process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(`window.__minimapIdentity=${JSON.stringify(nonce)}`)})`,
		);
		assert.equal(await renderer.eval("window.__minimapIdentity"), nonce);
		if (moduleFile) {
			assert(moduleFile.startsWith(join(identity.appPath, "out/renderer/assets") + sep));
			assert(
				(await renderer.eval("location.href")).startsWith(
					new URL(`file://${identity.appPath}/out/renderer/`).href,
				),
			);
		} else {
			assert(
				await renderer.eval(
					"location.protocol==='http:' && ['localhost','127.0.0.1'].includes(location.hostname)",
				),
			);
		}
		verified = true;
		await wait(() =>
			renderer.eval('document.documentElement.dataset.appReady==="true"&&!document.querySelector("#splash")'),
		);
		await renderer.send("Emulation.setFocusEmulationEnabled", { enabled: true });
		await renderer.eval(
			moduleFile
				? `(async()=>{const m=await import(${JSON.stringify(new URL(`file://${moduleFile}`).href)});window.__minimap={s:m.diagSessions,t:m.diagTranscripts,h:{reloadSessionHistory:m.diagReload},p:m.diagPrefs,u:m.diagUi};return true})()`
				: `(async()=>{const [{useSessionsStore:s},{useTranscriptStore:t},h,{useUiPreferencesStore:p},{useUiStore:u}]=await Promise.all([import('/src/stores/sessions.ts'),import('/src/stores/transcript.ts'),import('/src/stores/session-history.ts'),import('/src/stores/ui-preferences.ts'),import('/src/stores/ui.ts')]);window.__minimap={s,t,h,p,u};return true})()`,
		);
		await renderer.eval(
			"(()=>{const {p,u}=__minimap;p.setState({centerOrbEnabled:false,sidebarCollapsed:true});u.getState().setDiffSidebarOpen(false);window.resizeTo(1440,960);return true})()",
		);
		await renderer.eval(
			`(()=>{const d=__minimap;d.start=()=>{d.frames=[];d.tasks=[];d.last=0;d.observer=new PerformanceObserver(l=>d.tasks.push(...l.getEntries().map(x=>x.duration)));d.observer.observe({entryTypes:['longtask']});const tick=t=>{if(d.last)d.frames.push(t-d.last);d.last=t;d.raf=requestAnimationFrame(tick)};d.raf=requestAnimationFrame(tick)};d.finish=()=>{cancelAnimationFrame(d.raf);d.tasks.push(...d.observer.takeRecords().map(x=>x.duration));d.observer.disconnect();return {frames:d.frames,longTasks:d.tasks,rows:document.querySelectorAll('[data-chat-row-key]').length,railMounted:document.querySelectorAll('[data-rail-index]').length}};return true})()`,
		);
		const measure = async (name, fn) => {
			await renderer.eval("__minimap.start()");
			const start = performance.now();
			const value = await fn();
			await frame();
			samples.push({
				name,
				elapsedMs: performance.now() - start,
				...(await renderer.eval("__minimap.finish()")),
				...value,
			});
		};
		const switchTo = async (n) => {
			await renderer.eval(`__minimap.s.getState().switchSession('review-${n}')`);
			await frame();
			assert.equal(await renderer.eval("__minimap.s.getState().activeSessionId"), `review-${n}`);
		};
		for (const n of options.turns) {
			phase = `open-${n}`;
			console.log(phase);
			await renderer.eval(
				`(()=>{__minimap.openDone=false;__minimap.s.getState().openFromHistory(${JSON.stringify(join(fixtures, `${n}.jsonl`))}).then(r=>{__minimap.openDone=r.ok},()=>{__minimap.openFailed=true});return true})()`,
			);
			await wait(async () => {
				if (await renderer.eval("__minimap.openFailed")) throw new Error("History open failed");
				const box = await renderer.eval(
					`(()=>{const b=[...document.querySelectorAll('button')].find(x=>['不信任','don’t trust','do not trust',String.fromCharCode(100,111,110,39,116,32,116,114,117,115,116)].includes(x.textContent?.trim().toLowerCase()));if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
				);
				if (box) {
					await renderer.send("Input.dispatchMouseEvent", {
						type: "mousePressed",
						...box,
						button: "left",
						clickCount: 1,
					});
					await renderer.send("Input.dispatchMouseEvent", {
						type: "mouseReleased",
						...box,
						button: "left",
						clickCount: 1,
					});
				}
				return renderer.eval("__minimap.openDone");
			});
			await wait(() => renderer.eval(`!!__minimap.t.getState().bySession['review-${n}']?.history`));
		}
		for (const full of [false, true]) {
			phase = `switch-${full ? "full" : "tail"}`;
			console.log(phase);
			if (full)
				for (const n of options.turns) {
					await switchTo(n);
					await renderer.eval(`__minimap.h.reloadSessionHistory('review-${n}',()=>true,true)`);
					await wait(
						() => renderer.eval(`!__minimap.t.getState().bySession['review-${n}'].history?.hasOlder`),
						60000,
					);
				}
			for (let r = 0; r < options.rounds; r++)
				for (let i = 0; i < options.switches * 2; i++) {
					const n = i % 2 ? options.turns.at(-1) : options.turns[0];
					await measure(`switch-${full ? "full" : "tail"}-${n}`, () => switchTo(n));
				}
		}
		for (const n of options.turns)
			for (let r = 0; r < options.rounds; r++) {
				phase = `stream-${n}-${r}`;
				console.log(phase);
				await switchTo(n);
				await renderer.eval(`__minimap.h.reloadSessionHistory('review-${n}',()=>true,true)`);
				await wait(
					() =>
						renderer.eval(
							`__minimap.t.getState().bySession['review-${n}']?.messages.length>=${n * 2} && !__minimap.t.getState().bySession['review-${n}'].history?.hasOlder`,
						),
					60000,
				);
				await measure(`stream-${n}`, async () => {
					await main.eval(
						`(()=>{const w=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows()[0];const send=event=>w.webContents.send('pi:event',{sessionId:'review-${n}',event});send({type:'agent_start'});send({type:'turn_start'});send({type:'message_start',message:{role:'user',content:[{type:'text',text:'Synthetic probe'}],timestamp:1700010000000}});send({type:'message_start',message:{role:'assistant',content:[],timestamp:1700010000001}});const s=globalThis.__minimapStream={count:0,done:false};s.timer=setInterval(()=>{send({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'Synthetic streamed text. '}});if(++s.count===150){clearInterval(s.timer);send({type:'turn_end',message:{role:'assistant',stopReason:'stop'}});send({type:'agent_end',messages:[]});s.done=true}},20);return true})()`,
					);
					const inputs = [];
					assert(
						await renderer.eval(
							"(()=>{const e=document.querySelector('[contenteditable=true]');e?.focus();return document.activeElement===e && !!e})()",
						),
					);
					for (let i = 0; i < 8; i++) {
						const start = performance.now();
						await renderer.send("Input.insertText", { text: "x" });
						await frame();
						inputs.push({
							ms: performance.now() - start,
							duringStream: !(await main.eval("__minimapStream.done")),
						});
						await pause(50);
					}
					await wait(() => main.eval("__minimapStream.done"), 15000);
					await wait(() =>
						renderer.eval(`__minimap.t.getState().bySession['review-${n}'].agentActive===false`),
					);
					return { inputs, increments: await main.eval("__minimapStream.count") };
				});
			}
		await writeFile(
			join(task, "minimap-results.json"),
			JSON.stringify(
				{
					mode: moduleFile ? "built-renderer" : "dev",
					rounds: options.rounds,
					switchesPerDirection: options.switches,
					turns: options.turns,
					window: await renderer.eval("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})"),
					samples,
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
		console.log("Collection complete; synthetic timings saved to isolated task directory.");
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		await cleanup();
	}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	run().catch((error) => {
		console.error("Collection failed:", error.name, error.message.split("\n")[0]);
		console.error(error.stack?.split("\n").find((line) => line.includes("check-conversation-minimap.mjs:")));
		process.exitCode = 1;
	});
