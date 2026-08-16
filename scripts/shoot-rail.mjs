/**
 * SessionRail 波浪动画逐帧截图（确定性 scrub，非实时抓拍）
 *
 * 原理：
 * - CDP `Page.captureScreenshot` 拿的是 Chromium 合成器的页面表面（纯 DOM 渲染结果），
 *   不经过屏幕、不需要录屏权限、不怕窗口遮挡，比 macOS screencapture 准且无干扰。
 * - `document.getAnimations()` 能拿到所有 CSS transition/animation，pause 后用
 *   `currentTime` 把动画时钟钉在指定毫秒 —— 每一帧都是精确时刻，零竞态。
 *
 * 前置：dev 应用带调试端口运行：npm run dev -- --remote-debugging-port=9224
 *   （且设置 → 外观 已打开左侧会话轨道、顶栏有 ≥3 个会话；
 *     或预先 seed userData/tabs.json + ui-state.json，见本目录 git 历史）
 *
 * 用法：
 *   node scripts/shoot-rail.mjs [phase] [outDir]
 *   phase = enter（悬停展开，默认）| leave（移开收起）| sweep（相邻项划过，波浪移动）| all
 *   例：node scripts/shoot-rail.mjs all /tmp/rail-frames
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const phase = process.argv[2] ?? "all";
const outDir = process.argv[3] ?? "/tmp/rail-frames";
mkdirSync(outDir, { recursive: true });

/* 帧采样点（ms）：展开尺寸 340ms + 阴影 220+80ms + 内容 180+110ms，全覆盖到 520 */
const ENTER_TIMES = [0, 30, 60, 90, 120, 160, 200, 240, 280, 320, 360, 400, 450, 520];
/* 收起 260ms + 翻色延迟 150+80ms */
const LEAVE_TIMES = [0, 40, 80, 120, 160, 200, 240, 300];
/* 划过 = 旧项 expanded→±1 收缩 300ms + 新项 ±1→expanded 340ms */
const SWEEP_TIMES = [0, 40, 80, 120, 160, 200, 240, 280, 340, 420];

/* ---------- CDP 连接 ---------- */
const listJson = execSync("curl -s http://127.0.0.1:9224/json").toString();
const page = JSON.parse(listJson).find((x) => x.type === "page");
if (!page) {
	console.error("没有找到 page target，dev 应用是否在 9224 端口运行？");
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
async function evalJs(expression) {
	const result = await send("Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: true,
	});
	if (result.exceptionDetails) {
		throw new Error(`页面内执行失败: ${JSON.stringify(result.exceptionDetails, null, 2)}`);
	}
	return result.result?.value;
}
/* 合成器偶发给出整帧纯色空白（PNG 极度压缩后仅几 KB，正常帧 ≥15KB），
   动画是暂停钉死状态的，等一拍重截同一帧是确定性的；12KB 阈值 + 最多 3 次 */
async function shot(name, clip) {
	for (let attempt = 1; attempt <= 3; attempt++) {
		const { data } = await send("Page.captureScreenshot", { format: "png", clip });
		const buf = Buffer.from(data, "base64");
		if (buf.length > 12000) {
			writeFileSync(join(outDir, `${name}.png`), buf);
			console.log(`  ${name}.png${attempt > 1 ? `（重试 ${attempt - 1} 次后成功）` : ""}`);
			return;
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	console.log(`  ${name}.png ⚠ 3 次都是空白帧，已跳过`);
}

/* ---------- 页面内动作 ---------- */

/** 触发悬停/移开并冻结新产生的动画：pause 全部，无限动画（呼吸）钉在 50% 相位（不透明），
 *  有限动画记录各自 base currentTime 挂到 window.__railAnims 供逐帧 scrub */
const beginAction = `(async (idx, enter) => {
	const items = [...document.querySelectorAll(".session-rail-item")];
	if (items.length < 3) throw new Error("轨道项不足（<3），先开几个会话并打开轨道开关");
	const el = items[idx];
	el.dispatchEvent(new MouseEvent(enter ? "mouseover" : "mouseout", { bubbles: true }));
	// React 状态 flush + transition 创建
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	const anims = document.getAnimations().filter((a) => a.playState !== "idle");
	for (const a of anims) a.pause();
	window.__railAnims = anims.map((a) => {
		const timing = a.effect?.getTiming?.() ?? {};
		const infinite = timing.iterations === Infinity;
		if (infinite) a.currentTime = 1600; // avatar-breathe 50% = 全不透明，帧间不闪
		return { anim: a, base: infinite ? null : (a.currentTime ?? 0) };
	});
	return { count: items.length, anims: window.__railAnims.length };
})`;

/** 把所有有限动画钉在 base + t 毫秒，等一帧让合成器出新画面 */
const scrubTo = `(async (t) => {
	for (const { anim, base } of window.__railAnims ?? []) {
		if (base !== null) anim.currentTime = base + t;
	}
	await new Promise((r) => requestAnimationFrame(r));
	return true;
})`;

/** 目标项中心附近的裁剪区（CSS 像素）：覆盖 ±2 以上及以下各数行 */
const clipOf = `(async (idx) => {
	const items = [...document.querySelectorAll(".session-rail-item")];
	const r = items[idx].getBoundingClientRect();
	const cy = r.top + r.height / 2;
	return { x: 0, y: Math.max(0, Math.round(cy - 112)), width: 340, height: 224, scale: 1 };
})`;

async function captureSequence(tag, idx, enter, times) {
	const info = await evalJs(`${beginAction}(${idx}, ${enter})`);
	console.log(`${tag}: ${info.count} 项, ${info.anims} 个动画已冻结`);
	const clip = await evalJs(`${clipOf}(${idx})`);
	for (const t of times) {
		await evalJs(`${scrubTo}(${t})`);
		await shot(`${tag}-t${String(t).padStart(3, "0")}`, clip);
	}
}

/* ---------- 主流程 ---------- */
const targetIndex = await evalJs(
	`(async () => Math.floor(document.querySelectorAll(".session-rail-item").length / 2))()`,
);
console.log(`目标项 index = ${targetIndex}`);

if (phase === "enter" || phase === "all") {
	await captureSequence("enter", targetIndex, true, ENTER_TIMES);
}
if (phase === "leave" || phase === "all") {
	// 从完全展开态出发：先悬停并直接跳到终点
	if (phase === "leave") {
		await evalJs(`${beginAction}(${targetIndex}, true)`);
		await evalJs(`${scrubTo}(600)`);
	}
	await captureSequence("leave", targetIndex, false, LEAVE_TIMES);
}
if (phase === "sweep" || phase === "all") {
	// 先完全展开 targetIndex，再划到下一项：旧项 expanded→±1、新项 ±1→expanded
	await evalJs(`${beginAction}(${targetIndex}, true)`);
	await evalJs(`${scrubTo}(600)`);
	await captureSequence("sweep", targetIndex + 1, true, SWEEP_TIMES);
}

/* 收尾：恢复动画播放（转到终态/呼吸继续），页面不留冰冻状态 */
await evalJs(`(() => {
	for (const { anim } of window.__railAnims ?? []) anim.play();
	window.__railAnims = null;
	return true;
})()`);
ws.close();
console.log(`完成 → ${outDir}`);
process.exit(0);
