#!/usr/bin/env node
/** 仅迁移隔离合成副本：真实确认→整理→SDK图片→恢复，不修改原夹具或正式会话。 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";

async function modelPayload(file) {
	const manager = SessionManager.open(file);
	// 性能夹具的assistant省略usage；仅为离线编码捕获补零，不修改磁盘或内容。
	const messages = convertToLlm(manager.buildSessionContext().messages).map((message) =>
		message.role === "assistant"
			? {
					...message,
					api: message.api ?? "openai-completions",
					provider: message.provider ?? "synthetic",
					model: message.model ?? "maintenance-boundary",
					stopReason: message.stopReason ?? "stop",
					usage: message.usage ?? {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}
			: message,
	);
	const model = {
		id: "maintenance-boundary",
		name: "Synthetic",
		provider: "synthetic",
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		input: ["text", "image"],
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	let payload;
	const fetch = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("Network forbidden in maintenance acceptance");
	};
	try {
		await streamSimple(
			model,
			{ messages },
			{
				apiKey: "synthetic-not-real",
				onPayload: (value) => {
					payload = value;
					throw new Error("Captured; no network");
				},
			},
		).result();
	} finally {
		globalThis.fetch = fetch;
	}
	assert(payload, "Provider payload was not captured");
	return JSON.stringify(payload);
}
const root = resolve(import.meta.dirname, "../.local/tmp/session-switch-diagnostics"),
	port = Number(process.env.PERCHO_CDP_PORT ?? 9227);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(
	(row) => row.type === "page",
);
if (!target) throw new Error("No isolated renderer");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => {
	ws.addEventListener("open", r, { once: true });
	ws.addEventListener("error", j, { once: true });
});
let next = 0;
const waiting = new Map();
ws.addEventListener("message", (event) => {
	const value = JSON.parse(String(event.data));
	if (value.id) {
		const pending = waiting.get(value.id);
		waiting.delete(value.id);
		clearTimeout(pending?.timer);
		value.error ? pending?.reject(new Error(value.error.message)) : pending?.resolve(value.result);
	}
});
const send = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const id = ++next,
			timer = setTimeout(() => {
				waiting.delete(id);
				reject(new Error(`CDP timeout: ${method}`));
			}, 75000);
		waiting.set(id, { resolve, reject, timer });
		ws.send(JSON.stringify({ id, method, params }));
	});
const evaluate = async (expression) => {
	new Function(`return (${expression});`);
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails)
		throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
	return result.result?.value;
};
let file, original, originalFixture, originalFixtureHash;
const records = [];
try {
	const fixture = await evaluate(
		`(async()=>{const rows=await window.pi.getSessionSwitchFixtures();return rows.find(row=>row.name==='screenshots')})()`,
	);
	assert(fixture.file.startsWith(join(root, "agent", "sessions")));
	originalFixture = fixture.file;
	const raw = await readFile(fixture.file);
	originalFixtureHash = digest(raw);
	const lines = raw.toString("utf8").trimEnd().split("\n");
	const header = JSON.parse(lines[0]),
		owner = randomUUID();
	header.id = owner;
	header.maintenanceUnknown = { retain: true };
	lines[0] = JSON.stringify(header);
	original = Buffer.from(lines.join("\n") + "\n\nnot json\r\n");
	file = join(root, "agent", "sessions", `maintenance-${owner}.jsonl`);
	await writeFile(file, original, { flag: "wx", mode: 0o600 });
	await send("Emulation.setFocusEmulationEnabled", { enabled: true });
	await send("Page.reload");
	await new Promise((r) => setTimeout(r, 1000));
	await evaluate(`(async()=>{
		const load=path=>import(performance.getEntriesByType('resource').map(entry=>entry.name).findLast(name=>new URL(name).pathname===path)??path);
		const [{useSessionMediaMaintenanceStore: modal},{useSessionsStore:sessions},{getExecutionApi}]=await Promise.all([load('/src/stores/session-media-maintenance.ts'),load('/src/stores/sessions.ts'),load('/src/environment-api.ts')]);
		window.__maintenanceTest={modal,sessions,api:getExecutionApi(${JSON.stringify(owner)}),meta:{sessionId:${JSON.stringify(owner)},sessionFile:${JSON.stringify(file)},cwd:${JSON.stringify(header.cwd)}}};
		modal.getState().open(window.__maintenanceTest.meta);
	})()`);
	const wait = async (expression) => {
		const end = Date.now() + 45000;
		for (;;) {
			const value = await evaluate(expression);
			if (value) return value;
			if (Date.now() > end) throw new Error("Acceptance wait timed out: " + expression);
			await new Promise((r) => setTimeout(r, 50));
		}
	};
	const click = (label) =>
		evaluate(
			`(()=>{const button=Array.from(document.querySelectorAll('[role="dialog"] button')).find(node=>${JSON.stringify(label)}.some(text=>node.textContent?.includes(text))&&!node.disabled);if(!button)throw new Error('No enabled action');button.click();return true})()`,
		);
	await wait(
		`Array.from(document.querySelectorAll('[role="dialog"] button')).some(node=>/整理并保留原件|Compact and retain original/.test(node.textContent??'')&&!node.disabled)`,
	);
	assert((await readFile(file)).equals(original), "Preview must not change source");
	await click(["整理并保留原件", "Compact and retain original"]);
	assert((await readFile(file)).equals(original), "First click is confirmation only");
	await click(["整理并保留原件", "Compact and retain original"]);
	const compact = await wait(
		`(async()=>{const test=window.__maintenanceTest,record=await test.api.getSessionMediaMaintenance({sessionFile:test.meta.sessionFile});return record?.phase==='complete'?record:null})()`,
	);
	records.push(compact);
	const compacted = await readFile(file),
		backup = await readFile(compact.backup);
	assert(backup.equals(original));
	assert(compacted.length < original.length * 0.2);
	assert(compacted.includes(Buffer.from("\n\nnot json\r\n")));
	const rows = compacted
		.toString("utf8")
		.split("\n")
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
	const images = rows.flatMap((row) => row.message?.details?.images ?? []);
	assert.equal(images.length, 63);
	assert(images.every((image) => image.kind === "reference"));
	const beforePayload = await modelPayload(compact.backup),
		afterPayload = await modelPayload(file);
	assert.equal(afterPayload, beforePayload, "Real SDK/provider model payload changed");
	assert(!afterPayload.includes("asset:"), "Display references leaked to provider");
	const rendered = await evaluate(`(async()=>{
		const test=window.__maintenanceTest;test.modal.getState().close();const opened=await test.sessions.getState().openFromHistory(test.meta.sessionFile);if(!opened.ok)throw new Error('Compacted source cannot open in real SDK');
		const end=performance.now()+20000;let image;while(!(image=document.querySelector('[data-history-image="ready"] img'))?.naturalWidth){document.querySelector('[data-history-image="ready"]')?.scrollIntoView({block:'center'});if(performance.now()>end)throw new Error('Compacted image cannot render');await new Promise(r=>setTimeout(r,20));}
		const value={width:image.naturalWidth,height:image.naturalHeight};test.sessions.getState().activateNewSessionDraft();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await test.sessions.getState().closeSession(test.meta.sessionId);test.modal.getState().open(test.meta);return value;
	})()`);
	assert(rendered.width > 0);
	await wait(
		`Array.from(document.querySelectorAll('[role="dialog"] button')).some(node=>/恢复独立原件|Restore independent original/.test(node.textContent??'')&&!node.disabled)`,
	);
	await click(["恢复独立原件", "Restore independent original"]);
	await click(["恢复独立原件", "Restore independent original"]);
	const restored = await wait(
		`(async()=>{const test=window.__maintenanceTest,record=await test.api.getSessionMediaMaintenance({sessionFile:test.meta.sessionFile});return record?.kind==='restore'&&record.phase==='complete'?record:null})()`,
	);
	records.push(restored);
	assert((await readFile(file)).equals(original), "Restore must recover byte-identical original");
	assert((await readFile(compact.backup)).equals(original));
	assert.equal(digest(await readFile(originalFixture)), originalFixtureHash);
	const report = {
		platform: process.platform,
		build: "dev",
		originalBytes: original.length,
		compactedBytes: compacted.length,
		images: images.length,
		explicitConfirmation: true,
		independentBackupMatches: true,
		unknownAndBadLinesRetained: true,
		realSdkRendered: rendered,
		restoredByteIdentical: true,
		originalFixtureUnchanged: true,
		realSdkProviderPayloadEqual: true,
		networkForbidden: true,
	};
	await writeFile(join(root, "ticket10-ui.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
} finally {
	await evaluate(
		`(async()=>{const test=window.__maintenanceTest;if(!test)return;test.modal.getState().close();test.sessions.getState().activateNewSessionDraft();await test.sessions.getState().closeSession(test.meta.sessionId);const record=await test.api.getSessionMediaMaintenance({sessionFile:test.meta.sessionFile});if(record&&record.phase!=='complete'&&record.phase!=='aborted')await test.api.cancelSessionMediaJob({jobId:record.operationId}).catch(()=>{});})()`,
	).catch(() => {});
	// 只清本脚本创建的副本/已完成事务；未完成记录保留供排障，不强行清走安全恢复门。
	if (records.length === 2) {
		await evaluate(
			`(async()=>{const test=window.__maintenanceTest;await test.api.deleteSession({sessionId:test.meta.sessionId,sessionFile:test.meta.sessionFile});delete window.__maintenanceTest})()`,
		).catch(() => {});
		for (const record of records) {
			await unlink(join(root, "agent/session-maintenance/records", `${digest(record.requestId)}.json`)).catch(
				() => {},
			);
			await unlink(join(root, "agent/session-maintenance/jobs", `${record.operationId}.json`)).catch(
				() => {},
			);
			if (record.kind === "compact")
				await rm(join(root, "agent/session-maintenance/backups", record.operationId), {
					recursive: true,
					force: true,
				});
		}
		await unlink(join(root, "agent/session-maintenance/files", `${digest(file)}.json`)).catch(() => {});
		await unlink(file).catch(() => {});
	}
	await send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
	ws.close();
}
