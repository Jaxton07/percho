#!/usr/bin/env node
/** Dev CDP runner, sharing the actual Settings diagnostic/navigation implementation. No mock IPC. */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { suiteRoot } from "./performance/paths.mjs";

const root = suiteRoot(
	resolve(import.meta.dirname, ".."),
	"switch",
	".local/tmp/session-switch-diagnostics",
	"PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT",
);

const port = Number(process.env.PERCHO_CDP_PORT ?? 9224);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid diagnostic CDP port");
const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(
	(item) => item.type === "page",
);
if (!target?.url.startsWith("http://localhost:"))
	throw new Error("Expected isolated dev renderer on the chosen diagnostic CDP port");
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
ws.addEventListener("message", ({ data }) => {
	const message = JSON.parse(data);
	const request = pending.get(message.id);
	if (!request) return;
	pending.delete(message.id);
	clearTimeout(request.timer);
	message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
});
await new Promise((resolve, reject) => {
	ws.addEventListener("open", resolve);
	ws.addEventListener("error", reject);
});
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const requestId = ++id;
		const timer = setTimeout(() => {
			pending.delete(requestId);
			reject(new Error("CDP timeout"));
		}, 30000);
		pending.set(requestId, { resolve, reject, timer });
		ws.send(JSON.stringify({ id: requestId, method, params }));
	});
}
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	return result.result?.value;
}
let focused = false;
try {
	// 端口可能属于另一个worktree：在任何焦点/导航改变之前确认本次根目录的隔离门。
	const fixtures = await evaluate("window.__diagnosticPreflight = window.pi.getSessionSwitchFixtures()");
	const expected = resolve(root, "agent/sessions");
	if (
		!Array.isArray(fixtures) ||
		fixtures.length !== 5 ||
		fixtures.some((fixture) => !fixture.file.startsWith(`${expected}/`))
	)
		throw new Error("CDP target does not belong to this isolated diagnostic instance");
	await send("Emulation.setFocusEmulationEnabled", { enabled: true });
	focused = true;
	if (!(await evaluate('document.documentElement.getAttribute("data-app-ready") === "true"')))
		throw new Error("Workbench not ready: adopt only the synthetic directory through startup UI first");
	await evaluate(`import("/src/lib/run-session-switch-diagnostics.ts?diagnostic=" + Date.now()).then(m => {
		window.__switchError = null; window.__switchReport = null;
		window.__switchRun = m.runSessionSwitchDiagnostics((done,total) => { window.__switchProgress = {done,total}; })
			.then(report => {window.__switchReport=report;})
			.catch(error => {window.__switchError=error.message;});
		return true;
	})`);
	const deadline = Date.now() + 300000;
	let report;
	while (Date.now() < deadline) {
		const status = await evaluate(
			"({error:window.__switchError,progress:window.__switchProgress,report:window.__switchReport})",
		);
		if (status.error) throw new Error(status.error);
		if (status.report) {
			report = status.report;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	if (!report) throw new Error("Diagnostic run timeout");
	const encoded = JSON.stringify(report, null, 2);
	if (/base64|Synthetic task|Synthetic output|\/Users\/|api[_-]?key/i.test(encoded))
		throw new Error("Diagnostic content/path leak");
	await writeFile(
		process.env.PERCHO_SESSION_SWITCH_REPORT_FILE ?? resolve(root, "dev-baseline.json"),
		encoded,
		{ mode: 0o600 },
	);
	console.log(JSON.stringify(report.summary, null, 2));
} finally {
	if (focused) await send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
	ws.close();
}
