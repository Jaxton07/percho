import { execSync } from "node:child_process";

const wsUrl = execSync(
	`curl -s http://127.0.0.1:9224/json | ${process.platform === "darwin" ? "" : ""} node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const p=j.find(x=>x.type==='page');console.log(p.webSocketDebuggerUrl)})"`,
)
	.toString()
	.trim();
const { WebSocket } = await import("ws");
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
ws.on("message", (data) => {
	const msg = JSON.parse(data.toString());
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
	}
});
await new Promise((r) => ws.on("open", r));
function send(method, params = {}) {
	return new Promise((resolve) => {
		const mid = ++id;
		pending.set(mid, resolve);
		ws.send(JSON.stringify({ id: mid, method, params }));
	});
}
const expr = process.argv[2];
const result = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
console.log(
	JSON.stringify(result.result?.result?.value ?? result.result?.exceptionDetails ?? result, null, 2),
);
ws.close();
process.exit(0);
