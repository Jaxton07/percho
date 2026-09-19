/**
 * 左侧栏开合动画逐帧截图（确定性关键帧复现）
 *
 * 为什么不用「pause + currentTime 逐帧」：实测在 Electron 里把 CSS transition 全量 pause 后，
 * 合成器不再产出新帧 —— `Page.captureScreenshot` 无论 fromSurface 真/假都返回同一张（陈旧或空白）图，
 * 逐帧 scrub 拿不到画面（记录在 `docs/PITFALLS.md`）。
 * 改为「按 CSS 实际参数复现每一步」：读真实的 transition 时长/缓动/延迟与两端取值，按缓动函数
 * 算出每一时刻的 width / opacity / transform，关掉过渡后写成 inline style 再截图 ——
 * 每一步都是真实 CSS 值的真实渲染，可重复、可对比、零竞态。
 *
 * 前置：dev 应用带调试端口运行：cd packages/desktop && npx electron-vite dev -- --remote-debugging-port=9224
 *   （注意：`npm run dev -- --remote-debugging-port=9224` 不生效，npm 会把参数吞掉）
 *
 * 用法：
 *   node scripts/shoot-sidebar.mjs [phase] [outDir]
 *   phase = collapse（默认）| expand | both（先收起再展开，两组帧）
 *   例：node scripts/shoot-sidebar.mjs both .local/tmp/sidebar-frames
 *
 * 换场景抄三步（见 AGENTS.md「UI 截图调试」）：
 *   1) 触发状态：React 合成事件（`click`/`contextmenu`/`mouseover`）+ 两个 rAF 等 flush
 *   2) 定帧：优先「按 CSS 参数写 inline style 复现每一步」（本脚本）—— 只在窗口前台可见时，暂停动画才出帧
 *   3) 截图：`Page.captureScreenshot({ clip })`，clip 单位是 CSS px，输出像素 = clip × DPR
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = process.env.CDP_PORT ?? "9224";
const phase = process.argv[2] ?? "collapse";
const outDir = process.argv[3] ?? ".local/tmp/sidebar-frames";
if (!["collapse", "expand", "both"].includes(phase)) {
	console.error(`phase 只能是 collapse / expand / both，收到 ${phase}`);
	process.exit(1);
}
mkdirSync(outDir, { recursive: true });

/** 取样时刻（ms）：覆盖宽度 400ms 全程 + 内容层 300/380ms（各带延迟）的尾段 */
const TIMES = [0, 40, 80, 120, 160, 200, 240, 280, 320, 380, 450, 520];
const CLIP = { x: 0, y: 0, width: 660, height: 420, scale: 1 };

/* ---------- CDP 连接（Node 内置 WebSocket，不额外依赖 ws） ---------- */
/** 等 page target 出现：dev 刚启动时端口已绑但页面还没 load */
async function findPage(timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const list = JSON.parse(execSync(`curl -s http://127.0.0.1:${PORT}/json`).toString());
			const found = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
			if (found) return found;
		} catch {
			/* 端口未绑/非 JSON：下一轮 */
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	console.error(`等不到 page target，dev 应用是否在 ${PORT} 端口运行？`);
	process.exit(1);
}
const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
	}
};
await new Promise((r) => (ws.onopen = r));
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++msgId;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
}
async function evalJs(expression) {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) {
		throw new Error(`页面内执行失败: ${JSON.stringify(result.exceptionDetails, null, 2)}`);
	}
	return result.result?.value;
}

await send("Emulation.setFocusEmulationEnabled", { enabled: true });

/** 截图：空白帧（合成器瞬时状态）按体积重试 */
async function shot(name, attempts = 4) {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const { data } = await send("Page.captureScreenshot", { format: "png", clip: CLIP });
		const buf = Buffer.from(data, "base64");
		if (buf.length > 12000) {
			writeFileSync(join(outDir, `${name}.png`), buf);
			console.log(`  ${name}.png${attempt > 1 ? `（第 ${attempt} 次成功）` : ""}`);
			return;
		}
		await new Promise((r) => setTimeout(r, 160));
	}
	console.log(`  ${name}.png ⚠ ${attempts} 次都是空白帧，已跳过`);
}

/* ---------- 页面内片段 ---------- */

const TOGGLE = `(() => {
	const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').includes('导航栏'));
	if (!btn) throw new Error('没找到左栏开合按钮（顶栏最左那个）');
	btn.click();
	return JSON.stringify({ label: btn.getAttribute('aria-label'), collapsed: document.querySelector('.sidebar').classList.contains('is-collapsed') });
})`;
const IS_COLLAPSED = `document.querySelector('.sidebar')?.classList.contains('is-collapsed') ?? null`;
const settle = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;

/** 读真实过渡参数与两端取值（不硬编码 CSS 常量：改 CSS 脚本自动跟随） */
const READ_SPEC = `(() => {
	const splitTop = (value) => {
		const out = [];
		let depth = 0;
		let cur = '';
		for (const ch of value) {
			if (ch === '(') depth++;
			else if (ch === ')') depth--;
			if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
			else cur += ch;
		}
		out.push(cur.trim());
		return out;
	};
	const sb = document.querySelector('.sidebar');
	const inner = sb.querySelector('.sidebar-inner');
	const read = (el) => {
		const cs = getComputedStyle(el);
		return {
			duration: splitTop(cs.transitionDuration).map((v) => parseFloat(v) * 1000),
			delay: splitTop(cs.transitionDelay).map((v) => parseFloat(v) * 1000),
			easing: splitTop(cs.transitionTimingFunction),
		};
	};
	const collapsed = sb.classList.contains('is-collapsed');
	return JSON.stringify({
		startCollapsed: collapsed,
		widthFrom: collapsed ? 0 : 240,
		widthTo: collapsed ? 240 : 0,
		sidebar: read(sb),
		inner: read(inner),
		// 收起态 = opacity 0 / translateX(-28px)；展开态 = opacity 1 / none（与 .sidebar-inner 的 CSS 对应）
		innerFrom: collapsed ? { opacity: 0, x: -28 } : { opacity: 1, x: 0 },
		innerTo: collapsed ? { opacity: 1, x: 0 } : { opacity: 0, x: -28 },
	});
})`;

const APPLY_STEP = `((spec, t) => {
	const sb = document.querySelector('.sidebar');
	const inner = sb.querySelector('.sidebar-inner');
	const bez = (p1x, p1y, p2x, p2y, x) => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
		const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
		const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
		const sample = (v) => ((ax * v + bx) * v + cx) * v;
		let lo = 0, hi = 1, mid = x;
		for (let i = 0; i < 24; i++) { mid = (lo + hi) / 2; if (sample(mid) < x) lo = mid; else hi = mid; }
		return ((ay * mid + by) * mid + cy) * mid;
	};
	const ease = (easing, x) => {
		const m = /cubic-bezier\\(([^)]+)\\)/.exec(easing);
		if (m) { const p = m[1].split(',').map(Number); return bez(p[0], p[1], p[2], p[3], x); }
		if (easing === 'linear') return x;
		if (easing.includes('ease-in-out')) return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) ** 2;
		if (easing.includes('ease-out') || easing === 'ease') return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) ** 2;
		return x;
	};
	// 每个属性各自按 duration/delay 折算进度（延迟段内保持 from 值）；i = transition 声明顺序里的第几个属性
	const progress = (list, dur, delay, i, tt) => {
		const d = dur[i] ?? dur[0] ?? 0;
		const dl = delay[i] ?? delay[0] ?? 0;
		return d <= 0 ? 1 : ease(list.easing[i] ?? list.easing[0] ?? 'linear', Math.min(1, Math.max(0, (tt - dl) / d)));
	};
	sb.style.transition = 'none';
	inner.style.transition = 'none';
	const wp = progress(spec.sidebar, spec.sidebar.duration, spec.sidebar.delay, 0, t);
	sb.style.width = (spec.widthFrom + (spec.widthTo - spec.widthFrom) * wp).toFixed(2) + 'px';
	const op = progress(spec.inner, spec.inner.duration, spec.inner.delay, 0, t);
	const tx = progress(spec.inner, spec.inner.duration, spec.inner.delay, 1, t);
	inner.style.opacity = (spec.innerFrom.opacity + (spec.innerTo.opacity - spec.innerFrom.opacity) * op).toFixed(3);
	const x = spec.innerFrom.x + (spec.innerTo.x - spec.innerFrom.x) * tx;
	inner.style.transform = 'translateX(' + x.toFixed(2) + 'px)';
	return JSON.stringify({ t, width: getComputedStyle(sb).width, opacity: getComputedStyle(inner).opacity, x: x.toFixed(2) });
})`;

const RESET = `(() => {
	const sb = document.querySelector('.sidebar');
	sb.style.cssText = '';
	sb.querySelector('.sidebar-inner').style.cssText = '';
	return true;
})`;

/* ---------- 主流程 ---------- */
async function captureSequence(dir) {
	// 起点：dir=collapse 要「已展开」起步，dir=expand 要「已收起」起步
	let collapsed = await evalJs(IS_COLLAPSED);
	const wantCollapsed = dir === "expand";
	if (collapsed !== wantCollapsed) {
		await evalJs(`${TOGGLE}()`);
		await new Promise((r) => setTimeout(r, 700)); // 等真实过渡跑完再当起点
		collapsed = await evalJs(IS_COLLAPSED);
	}
	const spec = JSON.parse(await evalJs(`${READ_SPEC}()`));
	console.log(
		`${dir}：${spec.widthFrom}→${spec.widthTo}px（${spec.sidebar.duration[0]}ms / ${spec.sidebar.easing[0]}），` +
			`内容 opacity ${spec.innerFrom.opacity}→${spec.innerTo.opacity}（${spec.inner.duration[0]}ms + ${spec.inner.delay[0]}ms）`,
	);
	// 真实点一次让 class 落到终态（边框等非过渡属性按终态），随后用 inline style 复现中间帧
	await evalJs(`${TOGGLE}()`);
	await evalJs(settle);
	for (const t of TIMES) {
		const state = JSON.parse(await evalJs(`${APPLY_STEP}(${JSON.stringify(spec)}, ${t})`));
		await evalJs(settle);
		await shot(`${dir}-t${String(t).padStart(3, "0")}`);
		if (t % 80 === 0) console.log(`    t=${state.t}ms → 宽 ${state.width} / 内容 opacity ${state.opacity}`);
	}
	await evalJs(`${RESET}()`);
	await new Promise((r) => setTimeout(r, 500)); // 让页面回到真实终态
}

if (phase === "both") {
	await captureSequence("collapse");
	await captureSequence("expand");
} else {
	await captureSequence(phase);
}

ws.close();
console.log(`完成 → ${outDir}`);
process.exit(0);
