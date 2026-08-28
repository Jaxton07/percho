/**
 * README demo GIF 帧拍摄：node scripts/shoot-demo-gif.mjs chat|settings
 * 前置：dev 带 --remote-debugging-port=9224 运行，浅色主题、无背景图、桌宠启用。
 * chat 场景：欢迎页打字 → 斜杠菜单 → 主会话滚动 → 展开工具卡 → 回底
 * settings 场景：项目页 → 打开设置 → providers 滚动 → 视觉 → 通用 → 局域网观察 → 关闭
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scene = process.argv[2] ?? "chat";
const outDir = `/tmp/frames-${scene}`;
mkdirSync(outDir, { recursive: true });

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
async function ev(expression) {
	const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.text}`);
	return r.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = { x: 0, y: 0, width: 1100, height: 750, scale: 1 };
let frameNo = 0;
async function frame(name) {
	for (let attempt = 1; attempt <= 4; attempt++) {
		const { data } = await send("Page.captureScreenshot", { format: "png", clip });
		const buf = Buffer.from(data, "base64");
		if (buf.length > 12000) {
			writeFileSync(join(outDir, `f${String(++frameNo).padStart(3, "0")}-${name}.png`), buf);
			console.log(`  f${String(frameNo).padStart(3, "0")} ${name}`);
			return;
		}
		await sleep(150);
	}
	console.log(`  ⚠ ${name} blank`);
}

/* ---------- 公共动作 ---------- */

/** React 受控 textarea 逐字输入 */
async function typeText(text) {
	return ev(`(() => {
		const ta = document.querySelector('textarea');
		if (!ta) return 'no textarea';
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
		setter.call(ta, ${JSON.stringify(text)});
		ta.dispatchEvent(new Event('input', { bubbles: true }));
		return 'ok';
	})()`);
}
async function typeChar(ch) {
	await ev(`(() => {
		const ta = document.querySelector('textarea');
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
		setter.call(ta, ta.value + ${JSON.stringify(ch)});
		ta.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	})()`);
}

/* ---------- chat 场景 ---------- */
async function sceneChat() {
	// 切到 welcome draft tab（最后一个 tab）
	await ev(
		`(() => { const t = [...document.querySelectorAll('.tab-pill')].pop(); t?.click(); return true; })()`,
	);
	await sleep(900);
	await frame("welcome");

	// 聚焦输入框 + 逐字打字
	const prompt = "Show me the project structure.";
	await ev(`(() => { document.querySelector('textarea')?.focus(); return true; })()`);
	await sleep(500);
	await frame("focus");
	for (const ch of prompt) {
		await typeChar(ch);
		await sleep(90);
	}
	await sleep(350);
	await frame("typed");

	// 清空 → 打 "/" 展示斜杠菜单
	await typeText("/");
	await sleep(600);
	await frame("slash-menu");

	// 清空，切主会话 tab
	await typeText("");
	await ev(`(() => { document.activeElement?.blur?.(); return true; })()`);
	await ev(
		`(() => { const t = [...document.querySelectorAll('.tab-pill')][0]; t?.click(); return true; })()`,
	);
	await sleep(900);
	await frame("main-top");

	// 找到折叠组（summary/抽屉）并滚动一段，展示消息流
	await ev(
		`(() => { const sc = document.querySelector('.chat-scrollbar'); sc?.scrollBy({ top: 320 }); return true; })()`,
	);
	await sleep(700);
	await frame("scrolled-1");
	await ev(
		`(() => { const sc = document.querySelector('.chat-scrollbar'); sc?.scrollBy({ top: 480 }); return true; })()`,
	);
	await sleep(700);
	await frame("scrolled-2");

	// 展开第一个折叠工具组
	await ev(`(() => { const d = document.querySelector('.drawer-details'); d?.click(); return true; })()`);
	await sleep(900);
	await frame("tool-expanded");
	await ev(`(() => { document.querySelector('.drawer-details')?.click(); return true; })()`);
	await sleep(700);
	await frame("tool-collapsed");

	// 回到底部
	await ev(
		`(() => { const sc = document.querySelector('.chat-scrollbar'); sc?.scrollTo({ top: sc.scrollHeight }); return true; })()`,
	);
	await sleep(800);
	await frame("bottom");
}

/* ---------- settings 场景 ---------- */
async function sceneSettings() {
	// 先到项目页
	await ev(
		`(() => { const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '项目'); b?.click(); return true; })()`,
	);
	await sleep(900);
	await frame("projects");

	// 打开设置（store 直达，动画由 React 过渡产生）
	await ev(
		`(() => { const s = window.PerchoUI.stores.useSettingsStore.getState(); s.setOpen(true); s.setCategory('models'); return true; })()`,
	);
	await sleep(500);
	await frame("open");
	await sleep(400);
	await frame("models-1");

	// providers 列表滚动
	await ev(
		`(() => { const sc = [...document.querySelectorAll('[class*=overflow-y-auto], [class*=overflow-auto]')].find(e => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 200); sc?.scrollBy({ top: 260, behavior: 'instant' }); return sc ? 'ok' : 'none'; })()`,
	);
	await sleep(500);
	await frame("models-2");

	// 视觉面板
	await ev(
		`(() => { const s = window.PerchoUI.stores.useSettingsStore.getState(); s.setCategory('vision'); return true; })()`,
	);
	await sleep(600);
	await frame("vision");

	// 通用面板（上下文管理二态 + 权限 + 频道开关）
	await ev(
		`(() => { const s = window.PerchoUI.stores.useSettingsStore.getState(); s.setCategory('general'); return true; })()`,
	);
	await sleep(600);
	await frame("general");

	// 局域网观察
	await ev(
		`(() => { const s = window.PerchoUI.stores.useSettingsStore.getState(); s.setCategory('lan'); return true; })()`,
	);
	await sleep(600);
	await frame("lan");

	// 关闭
	await ev(
		`(() => { const s = window.PerchoUI.stores.useSettingsStore.getState(); s.setOpen(false); return true; })()`,
	);
	await sleep(300);
	await frame("closing");
	await sleep(500);
	await frame("closed");
}

if (scene === "chat") await sceneChat();
else if (scene === "settings") await sceneSettings();
else {
	console.error("scene must be chat|settings");
	process.exit(1);
}
ws.close();
console.log(`done → ${outDir} (${frameNo} frames)`);
process.exit(0);
