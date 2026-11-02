/** Bounded CDP client used only by isolated diagnostic runners. */
import assert from "node:assert/strict";
export async function connect(port) {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const target = targets.find((t) => t.type === "page") ?? targets[0];
	assert(target?.webSocketDebuggerUrl, "Missing CDP target");
	const ws = new WebSocket(target.webSocketDebuggerUrl),
		pending = new Map();
	let sequence = 0;
	ws.addEventListener("message", ({ data }) => {
		const msg = JSON.parse(String(data)),
			p = pending.get(msg.id);
		if (!p) return;
		pending.delete(msg.id);
		clearTimeout(p.timer);
		msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
	});
	await new Promise((r, j) => {
		ws.addEventListener("open", r, { once: true });
		ws.addEventListener("error", j, { once: true });
	});
	ws.addEventListener("close", () => {
		for (const p of pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error("CDP closed"));
		}
		pending.clear();
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++sequence,
				timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`CDP timeout: ${method}`));
				}, 45000);
			pending.set(id, { resolve, reject, timer });
			ws.send(JSON.stringify({ id, method, params }));
		});
	return {
		send,
		on: (method, callback) => {
			const listener = ({ data }) => {
				const message = JSON.parse(String(data));
				if (message.method === method) callback(message.params);
			};
			ws.addEventListener("message", listener);
			return () => ws.removeEventListener("message", listener);
		},
		close: () => ws.close(),
		eval: async (expression) => {
			const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
			if (r.exceptionDetails)
				throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
			return r.result?.value;
		},
	};
}
