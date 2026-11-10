#!/usr/bin/env node
/** 真实隔离Electron：引用负载、旧单/多图、原图预览和GC。只修改临时合成副本。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { suiteRoot } from "./performance/paths.mjs";

const root = suiteRoot(
	resolve(import.meta.dirname, ".."),
	"switch",
	".local/tmp/session-switch-diagnostics",
	"PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT",
);
const port = Number(process.env.PERCHO_CDP_PORT ?? 9224);
const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(
	(item) => item.type === "page",
);
if (!target) throw new Error("Isolated renderer not found");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});
let serial = 0;
const pending = new Map();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	const callback = pending.get(message.id);
	if (callback) {
		pending.delete(message.id);
		callback(message);
	}
};
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++serial;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${method} timed out`));
		}, 60000);
		pending.set(id, (message) => {
			clearTimeout(timer);
			message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
		});
		ws.send(JSON.stringify({ id, method, params }));
	});
}
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails)
		throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
	return result.result.value;
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let focused = false;
const temporary = [];
const temporaryMedia = [];
const cases = [];
try {
	const fixtures = await evaluate("window.pi.getSessionSwitchFixtures()");
	assert(
		fixtures.length === 5 &&
			fixtures.every((item) => resolve(item.file).startsWith(`${join(root, "agent")}${sep}`)),
		"Not this checkout's isolated fixtures",
	);
	const source = fixtures.find((item) => item.name === "screenshots");
	assert(source);
	const original = await readFile(source.file),
		entries = original
			.toString("utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
	const originals = new Set();
	for (const entry of entries)
		for (const image of entry.message?.details?.images ?? [])
			if (typeof image.data === "string") originals.add(hash(Buffer.from(image.data, "base64")));
	assert(originals.size > 1);
	await send("Emulation.setFocusEmulationEnabled", { enabled: true });
	focused = true;
	await send("Page.bringToFront");
	await evaluate(
		`(async () => { const s = await import('/src/stores/sessions.ts'); window.__imageSessions = s.useSessionsStore; window.__imageService = (await import('/src/components/chat/history-image/history-image-service.ts')).thumbnailService(); window.__imageReader = (await import('/src/components/chat/history-image/image-reader.ts')).imageReader; window.__imageApi = (await import('/src/environment-api.ts')).getExecutionApi; window.__imageReady = (await import('/src/stores/session-history.ts')).isHistoryReady; window.__imageFrames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const create = URL.createObjectURL, revoke = URL.revokeObjectURL; window.__imageBlobs = new Map(); URL.createObjectURL = blob => { const url = create.call(URL, blob); window.__imageBlobs.set(url, blob); return url; }; URL.revokeObjectURL = url => { window.__imageBlobs.delete(url); revoke.call(URL, url); }; window.__restoreImageBlobs = () => { URL.createObjectURL = create; URL.revokeObjectURL = revoke; window.__imageBlobs.clear(); };  const a = await import('/src/stores/settings.ts'); a.useLocalSettingsStore.getState().setOpen(false); })()`,
	);
	for (const mode of ["array", "single", "multi", "attachments", "readonly", "assets"]) {
		let file = source.file;
		if (mode !== "array") {
			const copy = entries.map((entry) => ({ ...entry }));
			copy[0] = { ...copy[0], id: `${copy[0].id}-${mode}` };
			const index = copy.findLastIndex(
				(entry) => entry.message?.role === "toolResult" && entry.message.details?.images?.length,
			);
			const entry = copy[index],
				{ images, ...details } = entry.message.details;
			copy[index] = {
				...entry,
				message: {
					...entry.message,
					details:
						mode === "single"
							? { ...details, image: images[0] }
							: { ...details, images: [images[0], { ...images[0] }] },
				},
			};
			if (mode === "attachments") {
				copy[index] = entry;
				const userIndex = copy.findLastIndex((row) => row.message?.role === "user");
				const original = Buffer.from(images[0].data, "base64"),
					large = Buffer.alloc(11 * 1024 * 1024);
				original.copy(large);
				originals.add(hash(large));
				copy[userIndex] = {
					...copy[userIndex],
					message: {
						...copy[userIndex].message,
						content: [
							{ type: "text", text: "Synthetic user attachments" },
							{ type: "image", mimeType: "image/png", data: large.toString("base64") },
							{ type: "image", ...images[0] },
						],
					},
				};
			}
			if (mode === "readonly" || mode === "assets") copy[index] = entry;
			if (mode === "assets") {
				const owner = copy[0].id,
					directory = join(root, "agent", "media", owner);
				temporaryMedia.push(directory);
				await mkdir(directory, { recursive: true, mode: 0o700 });
				for (let i = 1; i < copy.length; i++) {
					const row = copy[i];
					if (!row.message?.details?.images?.length) continue;
					const references = [];
					for (const image of row.message.details.images) {
						const bytes = Buffer.from(image.data, "base64"),
							sha256 = hash(bytes);
						await writeFile(join(directory, `${sha256}.bin`), bytes, { mode: 0o600 });
						await writeFile(
							join(directory, `${sha256}.json`),
							JSON.stringify({ version: 1, sha256, mimeType: image.mimeType, byteLength: bytes.length }),
							{ mode: 0o600 },
						);
						references.push({
							kind: "reference",
							ownerSessionId: "untrusted-copied-parent",
							id: `asset:${sha256}`,
							revision: sha256,
							mimeType: image.mimeType,
							byteLength: bytes.length,
						});
					}
					copy[i] = {
						...row,
						message: { ...row.message, details: { ...row.message.details, images: references } },
					};
				}
			}
			const directory =
				mode === "readonly"
					? join(root, "agent", "sessions-subagents", "image-acceptance")
					: dirname(source.file);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			file = join(directory, `acceptance-${mode}.jsonl`);
			temporary.push(file);
			await writeFile(file, `${copy.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
				mode: 0o600,
				flag: "wx",
			});
		}
		const before = hash(await readFile(file));
		const result = await evaluate(`(async () => {
			const imageSelector = ${JSON.stringify(mode === "attachments" ? ".group.justify-end [data-history-image]" : "[data-history-image]")};
			const wait = async predicate => { const until = performance.now() + 20000; while (!predicate()) { if (performance.now() > until) throw new Error('Image readiness timed out: ' + JSON.stringify({ active: window.__imageSessions.getState().activeSessionId, page: document.querySelector('[data-session-page]')?.getAttribute('data-session-id'), ready: window.__imageReady(window.__imageOwner), images: Array.from(document.querySelectorAll('[data-history-image]')).map(e => ({ state: e.dataset.historyImage, binding: e.dataset.historyImageBinding, root: e.dataset.historyImageRoot, width: e.querySelector('img')?.naturalWidth, complete: e.querySelector('img')?.complete, y: e.getBoundingClientRect().y, height: e.getBoundingClientRect().height })), resources: window.__imageService.stats() })); await new Promise(r => setTimeout(r, 20)); } };
			window.__imageSessions.getState().activateNewSessionDraft(); await window.__imageFrames(); window.__imageService.reset();
			const before = window.__imageReader.stats().requests; await window.pi.beginSessionSwitchProbe(); const sourceParsesBefore = (await window.pi.finishSessionSwitchProbe()).source.parses; await window.pi.beginSessionSwitchProbe();
			const opened = await window.__imageSessions.getState().openFromHistory(${JSON.stringify(file)}); if (!opened.ok) throw new Error('Synthetic history open failed'); const meta = opened.meta; window.__imageOwner = meta.sessionId;
			await wait(() => window.__imageReady(meta.sessionId) && document.querySelector(imageSelector + '[data-history-image="ready"]'));
			document.querySelector(imageSelector + '[data-history-image="ready"]').scrollIntoView({ block: 'center', behavior: 'instant' });
			await wait(() => document.querySelector(imageSelector + '[data-history-image="ready"] img')?.naturalWidth > 0);
			await window.__imageFrames();
			const firstReads = window.__imageReader.stats().requests - before;
			const api = window.__imageApi(meta.sessionId);
			const legacy = await api.getSessionMessages({ sessionId: meta.sessionId });
			const references = await api.getSessionMessages({ sessionId: meta.sessionId, imageMode: 'references' });
			const images = references.filter(row => row.role === 'image' || row.role === 'user').flatMap(row => row.images ?? []);
			if (!images.length || images.some(image => image.kind !== 'reference' || 'data' in image)) throw new Error('History contains inline images');
			const first = images[0]; let rejectedInvalidSources = 0;
			for (const invalid of [{ sessionId: 'missing-source', imageId: first.id, revision: first.revision }, { sessionId: meta.sessionId, imageId: first.id, revision: 'stale-version' }, { sessionId: meta.sessionId, imageId: first.id.startsWith('asset:') ? first.id.slice(0, -1) + (first.id.endsWith('0') ? '1' : '0') : first.id.replace(/:\\d+$/, ':9999'), revision: first.revision }, { sessionId: meta.sessionId, imageId: '../synthetic.png', revision: first.revision }]) { try { await api.getSessionImage(invalid); } catch { rejectedInvalidSources++; } }
			if (rejectedInvalidSources !== 4) throw new Error('Invalid source accepted');
			const legacyBytes = new TextEncoder().encode(JSON.stringify(legacy)).byteLength, referenceBytes = new TextEncoder().encode(JSON.stringify(references)).byteLength;
			document.querySelector(imageSelector + '[data-history-image="ready"] button').click();
			await wait(() => document.querySelector('[data-image-preview="open"] img')?.naturalWidth > 0);
			const preview = document.querySelector('[data-image-preview="open"] img');
			const previewUrl = preview.src, originalBlob = window.__imageBlobs.get(previewUrl); if (!originalBlob) throw new Error('Preview did not create a tracked Blob URL'); const bytes = await originalBlob.arrayBuffer();
			const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
			const previewSize = [preview.naturalWidth, preview.naturalHeight];
			document.querySelector('[data-image-preview="open"]').click(); await window.__imageFrames();
			const previewRevoked = !window.__imageBlobs.has(previewUrl);
			window.__imageSessions.getState().activateNewSessionDraft(); await window.__imageFrames();
			const closed = await window.__imageSessions.getState().closeSession(meta.sessionId); if (!closed.closed) throw new Error('SDK refused GC');
			await window.__imageFrames(); const backend = await window.pi.finishSessionSwitchProbe();
			let attachmentGcReopen = null, cacheGcReopen = null;
			{
				const beforeReads = window.__imageReader.stats().requests, beforeDecodes = window.__imageService.stats().decodedImages;
				const reopened = await window.__imageSessions.getState().openFromHistory(${JSON.stringify(file)}); if (!reopened.ok) throw new Error('Attachment GC reopen failed');
				await wait(() => document.querySelectorAll(imageSelector + '[data-history-image="ready"] img').length >= (${JSON.stringify(mode)} === 'attachments' ? 2 : 1));
				await window.__imageFrames();
				const rows = await api.getSessionMessages({ sessionId: meta.sessionId, imageMode: 'references' });
				cacheGcReopen = { requests: window.__imageReader.stats().requests - beforeReads, decodes: window.__imageService.stats().decodedImages - beforeDecodes };
				if (${JSON.stringify(mode)} === 'attachments') attachmentGcReopen = { requests: cacheGcReopen.requests, images: rows.filter(row => row.role === 'user').flatMap(row => row.images ?? []).length };
				window.__imageSessions.getState().activateNewSessionDraft(); await window.__imageFrames();
				await window.__imageSessions.getState().closeSession(meta.sessionId); await window.__imageFrames();
			}
			return { firstReads, attachmentGcReopen, cacheGcReopen, rejectedInvalidSources, imageCount: images.length, legacyBytes, referenceBytes, digest, previewSize, previewBytes: bytes.byteLength, previewRevoked, resources: window.__imageService.stats(), blobUrlsAfterGC: window.__imageBlobs.size, source: backend.source, sourceParsesDelta: backend.source.parses - sourceParsesBefore, sdkParse: backend.stages.sdkParse ?? 0 };
		})()`);
		assert(result.firstReads > 0 && result.firstReads < result.imageCount, "Not lazy loading");
		assert.deepEqual(
			result.cacheGcReopen,
			{ requests: 0, decodes: 0 },
			"Cached reopen repeated original reads or thumbnail decoding",
		);
		if (mode !== "assets")
			assert(result.referenceBytes <= result.legacyBytes * 0.1, "Less than 90% reduction");
		if (mode === "attachments") {
			assert(result.previewBytes > 10 * 1024 * 1024, "Old user attachment was capped or replaced");
			assert.deepEqual(
				result.attachmentGcReopen,
				{ requests: 0, images: 2 },
				"GC lost attachment references or repeated original reads",
			);
		}
		if (mode === "readonly") {
			assert.equal(result.sourceParsesDelta, 1);
			assert.equal(result.sdkParse, 0);
		}
		assert(originals.has(result.digest), "Preview is not an original image");
		assert(result.previewRevoked, "Preview URL retained");
		assert.equal(result.blobUrlsAfterGC, 0);
		assert.equal(result.resources.active, 0);
		assert.equal(result.resources.urls, 0);
		assert.equal(result.source.views, 0);
		assert.equal(hash(await readFile(file)), before, "Normal open rewrote JSONL");
		if (mode === "assets") {
			result.lifecycle = await evaluate(`(async () => {
				const store = window.__imageSessions, projects = (await import('/src/stores/projects.ts')).useProjectsStore;
				const opened = await store.getState().openFromHistory(${JSON.stringify(file)}); if (!opened.ok) throw new Error('Asset reopen failed');
				const source = opened.meta, api = window.__imageApi(source.sessionId);
				const rows = await api.getSessionMessages({ sessionId: source.sessionId, imageMode: 'references' });
				const target = rows.findLast(row => row.role === 'assistant' && row.text); if (!target) throw new Error('No fork entry');
				const fork = await api.forkSession({ sessionId: source.sessionId, ref: { entryId: target.entryId, text: target.text } }); window.__assetForkMeta = fork;
				const sourceAfter = await api.getSessionBaseline({ sessionId: source.sessionId, imageMode: 'references' });
				if (sourceAfter.meta.sessionId !== source.sessionId || sourceAfter.meta.sessionFile !== source.sessionFile) throw new Error('Fork changed source identity');
				store.getState().activateNewSessionDraft(); await window.__imageFrames(); await projects.getState().deleteSession(source);
				const forkOpened = await store.getState().openFromHistory(fork.sessionFile); if (!forkOpened.ok) throw new Error('Fork open after source delete failed'); window.__imageOwner = fork.sessionId;
				const until = performance.now() + 20000; while (!document.querySelector('[data-history-image="ready"] img')?.naturalWidth) { document.querySelector('[data-history-image="ready"]')?.scrollIntoView({ block: 'center', behavior: 'instant' }); if (performance.now() > until) throw new Error('Fork image did not render: ' + JSON.stringify({ active: store.getState().activeSessionId, page: document.querySelector('[data-session-page]')?.getAttribute('data-session-id'), ready: window.__imageReady(fork.sessionId), images: Array.from(document.querySelectorAll('[data-history-image]')).map(e => ({ state: e.dataset.historyImage, text: e.textContent?.slice(0,80), y: e.getBoundingClientRect().y })), resources: window.__imageService.stats() })); await new Promise(r => setTimeout(r, 20)); }
				const jsonl = await api.exportSession({ sessionId: fork.sessionId, format: 'jsonl' });
				const exported = jsonl.trim().split('\\n').map(line => JSON.parse(line));
				const html = await api.exportSession({ sessionId: fork.sessionId, format: 'html' });
				const encoded = html.match(/id="session-data"[^>]*>([^<]+)/)?.[1]; if (!encoded) throw new Error('No SDK HTML data');
				const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.trim()), c => c.charCodeAt(0))));
				const count = entries => { const images = entries.flatMap(row => row.message?.details?.images ?? []); if (!images.length || images.some(image => image.kind === 'reference' || typeof image.data !== 'string')) throw new Error('Export has unresolved assets'); return images.length; };
				const result = { jsonlBytes: new TextEncoder().encode(jsonl).byteLength, htmlBytes: new TextEncoder().encode(html).byteLength, jsonlImages: count(exported), htmlImages: count(data.entries), parentSessionMatches: exported[0].parentSession === source.sessionFile, sourceManagerUnchanged: true, forkRenderedAfterSourceDeleted: true };
				store.getState().activateNewSessionDraft(); await window.__imageFrames(); await projects.getState().deleteSession(fork); window.__assetForkMeta = null;
				return result;
			})()`);
			assert(result.lifecycle.jsonlBytes > 4 * 1024 * 1024);
			assert.equal(result.lifecycle.parentSessionMatches, true);
			assert.equal(result.lifecycle.jsonlImages, result.lifecycle.htmlImages);
		}
		cases.push({ mode, ...result, sourceUnchanged: true });
	}
	assert.equal(hash(await readFile(source.file)), hash(original));
	await writeFile(
		join(root, "ticket03-images.json"),
		JSON.stringify({ build: "dev", platform: process.platform, cases }, null, 2),
	);
	console.log(
		JSON.stringify(
			cases.map(({ mode, firstReads, imageCount, referenceBytes, previewRevoked, sourceUnchanged }) => ({
				mode,
				firstReads,
				imageCount,
				referenceBytes,
				previewRevoked,
				sourceUnchanged,
			})),
			null,
			2,
		),
	);
} finally {
	await evaluate(
		"(async () => { const store = window.__imageSessions?.getState(); if (store) { store.activateNewSessionDraft(); if (window.__imageOwner) await store.closeSession(window.__imageOwner); if (window.__assetForkMeta) { await (await import('/src/stores/projects.ts')).useProjectsStore.getState().deleteSession(window.__assetForkMeta); window.__assetForkMeta = null; } } window.__restoreImageBlobs?.(); })()",
	).catch(() => {});
	for (const file of temporary) await unlink(file).catch(() => {});
	for (const directory of temporaryMedia) await rm(directory, { recursive: true, force: true });
	if (focused) await send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
	ws.close();
}
