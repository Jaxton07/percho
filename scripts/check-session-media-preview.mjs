#!/usr/bin/env node
/** 隔离Electron的后台预览/菜单界面/导航验证，绝不执行整理。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../.local/tmp/session-switch-diagnostics");
const port = Number(process.env.PERCHO_CDP_PORT ?? 9227);
const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(
	(row) => row.type === "page",
);
if (!target) throw new Error("No isolated renderer");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => {
	ws.addEventListener("open", r, { once: true });
	ws.addEventListener("error", j, { once: true });
});
const waiting = new Map();
let next = 0;
ws.addEventListener("message", (event) => {
	const value = JSON.parse(String(event.data));
	if (value.id) {
		const pending = waiting.get(value.id);
		waiting.delete(value.id);
		value.error ? pending?.reject(new Error(value.error.message)) : pending?.resolve(value.result);
	}
});
const send = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const id = ++next;
		waiting.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails)
		throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
	return result.result?.value;
};
try {
	const fixture = await evaluate(
		`(async()=>{const rows=await window.pi.getSessionSwitchFixtures();return rows.find(row=>row.name==='screenshots')})()`,
	);
	assert(fixture.file.startsWith(root));
	// HMR后旧的动态import可能持有旧store；隔离实例刷新后再验真实挂载组件。
	await send("Emulation.setFocusEmulationEnabled", { enabled: true });
	await send("Page.reload");
	for (let i = 0; i < 100; i++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		if (
			await evaluate(
				"Boolean(window.pi && document.readyState === 'complete' && document.querySelector('#root')?.firstElementChild)",
			)
		)
			break;
	}
	const original = await readFile(fixture.file),
		digest = createHash("sha256").update(original).digest("hex");
	const report = await evaluate(`(async()=>{
		const load = path => import(performance.getEntriesByType('resource').map(entry=>entry.name).findLast(name=>new URL(name).pathname===path)??path);
		const [{useSessionsStore: sessions},{getExecutionApi},{useSessionMediaMaintenanceStore: modal}]=await Promise.all([load('/src/stores/sessions.ts'),load('/src/environment-api.ts'),load('/src/stores/session-media-maintenance.ts')]);
		const api=getExecutionApi('switch-diagnostic-screenshots'), started=performance.now();
		const job=await api.startSessionMediaPreview({sessionFile:${JSON.stringify(fixture.file)}}), startMilliseconds=performance.now()-started;
		let current=job;const deadline=performance.now()+30000;
		// 任务运行期间采用真实导航入口，不让一个长invoke锁住界面。
		const other=(await window.pi.getSessionSwitchFixtures()).find(row=>row.name==='text');
		const navigationStart=performance.now(), opened=await sessions.getState().openFromHistory(other.file); if(!opened.ok)throw new Error('Other-session navigation failed');
		await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); const navigationMilliseconds=performance.now()-navigationStart;
		sessions.getState().activateNewSessionDraft(); await sessions.getState().closeSession(opened.meta.sessionId);
		while(['queued','running','cancelling'].includes(current.status)){if(performance.now()>deadline)throw new Error('Preview query timed out');await new Promise(r=>setTimeout(r,20));current=await api.getSessionMediaJob({jobId:job.jobId});}
		if(current.status!=='completed')throw new Error(current.error??current.status);
		modal.getState().open({sessionId:'switch-diagnostic-screenshots',sessionFile:${JSON.stringify(fixture.file)}});
		while(!(document.querySelector('[role="dialog"]')?.textContent?.includes('63')&&document.querySelector('[role="dialog"]')?.textContent?.includes('MiB'))){if(performance.now()>deadline)throw new Error('Preview dialog did not finish: '+JSON.stringify({text:document.querySelector('[role="dialog"]')?.textContent,selected:modal.getState().session?.sessionId}));await new Promise(r=>setTimeout(r,20));}
		const visible=document.querySelector('[role="dialog"]');const summaryVisible=visible.textContent.includes('63')&&visible.textContent.includes('MiB');modal.getState().close();
		return {startMilliseconds,status:current.status,result:current.result,summaryVisible,navigatedWhileRunning:sessions.getState().activeSessionId===null,navigationMilliseconds};
	})()`);
	assert.equal(report.result.imageCount, 63);
	assert.equal(report.status, "completed");
	assert.equal(report.summaryVisible, true);
	assert.equal(report.navigatedWhileRunning, true);
	assert.equal(
		createHash("sha256")
			.update(await readFile(fixture.file))
			.digest("hex"),
		digest,
	);
	assert.equal(report.result.sourceHash, digest);
	// 不把输入路径、正文或owner写入可分享诊断。
	delete report.result.sessionId;
	delete report.result.sourceFingerprint;
	delete report.result.sourceHash;
	await writeFile(
		`${root}/ticket09-preview-ui.json`,
		JSON.stringify({ build: "dev", platform: process.platform, ...report, sourceUnchanged: true }, null, 2),
	);
	console.log(JSON.stringify(report, null, 2));
} finally {
	await evaluate(
		`(async()=>{try{(await import('/src/stores/session-media-maintenance.ts')).useSessionMediaMaintenanceStore.getState().close()}catch{}})()`,
	).catch(() => {});
	await send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
	ws.close();
}
