/**
 * CDP 通用截图工具：node scripts/cdp-shot.mjs <out.png> [x,y,width,height]
 * 默认截整个窗口内容区（CSS px 1100x750 → 2x Retina 输出）。空白帧自动重试。
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) {
	console.error("usage: node scripts/cdp-shot.mjs <out.png> [x,y,width,height]");
	process.exit(1);
}
const clipArg = process.argv[3]?.split(",").map(Number);
const clip = clipArg
	? { x: clipArg[0], y: clipArg[1], width: clipArg[2], height: clipArg[3], scale: 1 }
	: { x: 0, y: 0, width: 1100, height: 750, scale: 1 };

const listJson = execSync("curl -s http://127.0.0.1:9224/json").toString();
const page = JSON.parse(listJson).find((x) => x.type === "page");
if (!page) {
	console.error("no page target on 9224");
	process.exit(1);
}
const { WebSocket } = await import("ws");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
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
	return new Promise((resolve, reject) => {
		const id = ++msgId;
		pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
		ws.send(JSON.stringify({ id, method, params }));
	});
}
async function shot(name) {
	for (let attempt = 1; attempt <= 4; attempt++) {
		const { data } = await send("Page.captureScreenshot", { format: "png", clip });
		const buf = Buffer.from(data, "base64");
		if (buf.length > 12000) {
			writeFileSync(name, buf);
			console.log(`✓ ${name} (${(buf.length / 1024).toFixed(0)}KB, attempt ${attempt})`);
			return;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	console.log(`⚠ ${name}: 4 attempts all blank`);
}
await shot(out);
ws.close();
process.exit(0);
