/**
 * layout-freedom 验收脚本（spec `.local/agent-work/spec/layout-freedom.md` §9 的 V1/V2/V3）
 *
 * 前置：dev 应用带**两个**调试端口运行（页面 9224 + 主进程 9229，主进程探针需要它）：
 *   cd packages/desktop && npx electron-vite dev -- --remote-debugging-port=9224 --inspect=9229
 *   （注意：`npm run dev -- --xxx` 不行，npm 会把参数当自己的 config 吞掉）
 *
 * 用法：
 *   node scripts/verify-layout-freedom.mjs v1-css|v2-drag|v3-bounds|all [--stage0]
 *   `--stage0`：阶段 0 语义 —— V3 的「落盘 windowBounds」这一环尚不存在（阶段 2 才写），
 *   该子断言记 SKIP 而不是 FAIL。阶段 2 之后不加该参数，端到端必须真绿。
 *
 * 三个断言各自的用意（阶段 0 的卡点，见 plan）：
 *   V1 候选 CSS `width: min(var(--sidebar-width, 240px), calc(100% - 320px))` 能否与既有
 *      width 过渡 / overflow / `.is-collapsed { width: 0 }` 源序覆盖共存（阶段 1 是否可用这套写法）。
 *      → 阶段 0 用注入的候选 CSS 验证；阶段 1 之后脚本自动检测真实 CSS（探针样式不再注入）。
 *   V2 拖动期「关过渡（is-resizing）+ 松手恢复」是否跳帧/落后于指针；顺带跑一遍**不关过渡**的对照组，
 *      用实测滞后量证明这条决策的必要性；也回答「松手后是否有一段 0.4s 追赶动画」。
 *      → 阶段 0 用注入的探针把手（合成 pointer 事件）；阶段 1 之后自动改用真实把手 `data-sidebar-resize-handle`。
 *   V3 `window.resizeTo` 是否会让 main 进程收到 `resize`（→ 阶段 2 的防抖写盘才能端到端自动化）。
 *      → 主进程侧探针经 9229 的 Node inspector 注入（`process.mainModule.require('electron')`），
 *        **不改生产代码**；探针只在内存里，进程退出即消失。
 *
 * 退出码：0 全绿 / 1 有断言失败 / 2 环境不满足（端口不通等）。
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PAGE_PORT = process.env.CDP_PORT ?? "9224";
const MAIN_PORT = process.env.CDP_MAIN_PORT ?? "9229";
const DEV_UI_STATE = join(homedir(), "Library/Application Support/@percho/desktop-dev/ui-state.json");
const OUT_DIR = ".local/tmp/layout-freedom";
const STAGE0 = process.argv.includes("--stage0");
mkdirSync(OUT_DIR, { recursive: true });

/** 侧栏宽度的候选常量（与 shared 侧最终定义一致；本脚本只做探测，不 import 生产代码） */
const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;
const CHAT_MIN_WIDTH = 320;
/** 阶段 2 的防抖窗口（spec §5.1） */
const BOUNDS_SAVE_DEBOUNCE_MS = 400;

/* ---------------- 断言账本 ---------------- */
const results = [];
function record(name, ok, detail) {
	results.push({ name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", detail });
	const icon = ok === null ? "○" : ok ? "✅" : "❌";
	console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ""}`);
}
const check = (name, ok, detail) => record(name, ok, detail);
const skip = (name, detail) => record(name, null, detail);

/* ---------------- CDP 客户端（Node 内置 WebSocket） ---------------- */
function wsUrlOf(port, pick) {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 20000;
		const tick = () => {
			try {
				const list = JSON.parse(execSync(`curl -s http://127.0.0.1:${port}/json`).toString());
				const found = list.find(pick);
				if (found) return resolve(found.webSocketDebuggerUrl);
			} catch {
				/* 端口未绑/非 JSON：下一轮 */
			}
			if (Date.now() > deadline) return reject(new Error(`等不到 ${port} 的调试目标`));
			setTimeout(tick, 400);
		};
		tick();
	});
}

async function connect(port, pick) {
	const url = await wsUrlOf(port, pick);
	const ws = new WebSocket(url);
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
	await new Promise((r, j) => {
		ws.onopen = r;
		ws.onerror = () => j(new Error(`连接 ${url} 失败`));
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++msgId;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});
	return {
		send,
		close: () => ws.close(),
		async evalJs(expression) {
			const res = await send("Runtime.evaluate", {
				expression,
				returnByValue: true,
				awaitPromise: true,
			});
			if (res.exceptionDetails) {
				throw new Error(
					`页面内执行失败：${JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails)}`,
				);
			}
			return res.result?.value;
		},
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 页面侧片段 ---------------- */
const SETTLE = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;
const sleep0 = () => sleep(60);

/** 候选 CSS（阶段 1 的写法；阶段 0 注入验证，阶段 1 之后自动跳过注入） */
const CANDIDATE_CSS = `
.sidebar { width: min(var(--sidebar-width, 240px), calc(100% - ${CHAT_MIN_WIDTH}px)); }
.sidebar-inner { width: var(--sidebar-width, ${SIDEBAR_DEFAULT_WIDTH}px); }
.sidebar.is-resizing { transition: none; }
`;

const INJECT_CSS = `(() => {
	let el = document.getElementById("lf-probe-css");
	if (!el) { el = document.createElement("style"); el.id = "lf-probe-css"; document.head.append(el); }
	el.textContent = ${JSON.stringify(CANDIDATE_CSS)};
	return true;
})()`;

/** 真实 CSS 是否已能跟上 --sidebar-width（= 阶段 1 已落地） */
const DETECT_REAL_CSS = `(() => {
	const sb = document.querySelector(".sidebar");
	const before = sb.style.getPropertyValue("--sidebar-width");
	sb.style.setProperty("--sidebar-width", "300px");
	const w = parseFloat(getComputedStyle(sb).width);
	if (before) sb.style.setProperty("--sidebar-width", before); else sb.style.removeProperty("--sidebar-width");
	sb.style.removeProperty("width");
	return w;
})()`;

/** 阶段 0 的探针把手（不进生产代码；阶段 1 之后不会用到） */
const INSTALL_PROBE_HANDLE = `(() => {
	if (document.querySelector('[data-sidebar-resize-handle]')) return "real";
	const sb = document.querySelector(".sidebar");
	const el = document.createElement("div");
	el.setAttribute("data-sidebar-resize-handle", "probe");
	el.style.cssText = "position:absolute;top:0;bottom:0;right:0;width:8px;cursor:col-resize;z-index:50;";
	sb.append(el);
	window.__lfDrag = { disableTransition: true, moves: 0 };
	let dragging = false, startX = 0, startW = ${SIDEBAR_DEFAULT_WIDTH};
	const clamp = (v) => Math.max(${SIDEBAR_MIN_WIDTH}, Math.min(${SIDEBAR_MAX_WIDTH}, v));
	const finish = () => {
		if (!dragging) return;
		dragging = false;
		sb.classList.remove("is-resizing");
		document.body.style.cursor = "";
	};
	el.addEventListener("pointerdown", (e) => {
		dragging = true;
		startX = e.clientX;
		startW = parseFloat(sb.style.getPropertyValue("--sidebar-width")) || ${SIDEBAR_DEFAULT_WIDTH};
		if (window.__lfDrag.disableTransition) sb.classList.add("is-resizing");
		el.setPointerCapture(e.pointerId);
		document.body.style.cursor = "col-resize";
		e.preventDefault();
	});
	el.addEventListener("pointermove", (e) => {
		if (!dragging) return;
		window.__lfDrag.moves++;
		sb.style.setProperty("--sidebar-width", clamp(startW + (e.clientX - startX)) + "px");
	});
	el.addEventListener("pointerup", finish);
	el.addEventListener("pointercancel", finish);
	return "probe";
})()`;

/** 只复位拖动态与宽度变量（探针把手/样式保留，V1/V2 还要继续用） */
const RESET_DRAG_STATE = `(() => {
	const sb = document.querySelector(".sidebar");
	if (sb) { sb.classList.remove("is-resizing"); sb.style.removeProperty("--sidebar-width"); }
	document.body.style.cursor = "";
	return true;
})()`;

/** 收尾：探针把手与探针样式一起清掉 */
const CLEANUP = `(() => {
	document.querySelector('[data-sidebar-resize-handle="probe"]')?.remove();
	document.getElementById("lf-probe-css")?.remove();
	const sb = document.querySelector(".sidebar");
	if (sb) { sb.classList.remove("is-resizing"); sb.style.removeProperty("--sidebar-width"); }
	document.body.style.cursor = "";
	return true;
})()`;

const MEASURE = `(() => {
	const sb = document.querySelector(".sidebar");
	const parent = sb.parentElement;
	const chat = parent.children[1];
	const collapsed = sb.classList.contains("is-collapsed");
	return JSON.stringify({
		collapsed,
		sidebarWidth: parseFloat(getComputedStyle(sb).width),
		sidebarRect: sb.getBoundingClientRect().width,
		innerWidth: sb.querySelector(".sidebar-inner").getBoundingClientRect().width,
		parentWidth: parent.clientWidth,
		chatWidth: chat ? chat.getBoundingClientRect().width : null,
		varValue: sb.style.getPropertyValue("--sidebar-width"),
		docScrollWidth: document.documentElement.scrollWidth,
		docClientWidth: document.documentElement.clientWidth,
		revealAnimations: document.getAnimations().length,
	});
})()`;

const SET_WIDTH = (px) => `(() => {
	const sb = document.querySelector(".sidebar");
	sb.style.setProperty("--sidebar-width", "${px}px");
	return true;
})()`;

/** 等 2 个 rAF（React flush + 过渡创建）再取样 */
const MEASURE_AFTER_SETTLE = `(async () => { await ${SETTLE}; return ${MEASURE}; })()`;

const TOGGLE_COLLAPSE = `(() => {
	const btn = [...document.querySelectorAll("button")].find((b) =>
		/导航栏|sidebar/i.test(b.getAttribute("aria-label") || ""),
	);
	if (!btn) throw new Error("没找到顶栏最左的左栏开合按钮");
	btn.click();
	return true;
})()`;

const RESIZE_WINDOW = (w, h) =>
	`(() => { window.resizeTo(${w}, ${h}); return [window.outerWidth, window.outerHeight]; })()`;

/* ---------------- V1：候选 CSS 与过渡/折叠共存 ---------------- */
async function v1Css(page, { injectedCss }) {
	console.log(
		injectedCss ? "\n=== V1 候选 CSS（注入探针样式，阶段 0）===" : "\n=== V1 候选 CSS（真实 CSS 已落地）===",
	);
	await page.evalJs(SETTLE);
	await page.evalJs(SET_WIDTH(SIDEBAR_MAX_WIDTH));
	await sleep(600);

	// 常态：宽 = min(480, 容器宽 - 320)
	let m = JSON.parse(await page.evalJs(MEASURE));
	const expectedWide = Math.min(SIDEBAR_MAX_WIDTH, m.parentWidth - CHAT_MIN_WIDTH);
	check(
		"V1-a 常态 computed width = min(480, 容器宽-320)",
		Math.abs(m.sidebarWidth - expectedWide) < 1,
		`实测 ${m.sidebarWidth}px，期望 ${expectedWide}px（容器 ${m.parentWidth}px，聊天列 ${m.chatWidth?.toFixed(1)}px）`,
	);
	check("V1-b 常态聊天列 ≥ 320px", m.chatWidth >= CHAT_MIN_WIDTH - 1, `实测 ${m.chatWidth?.toFixed(1)}px`);
	check(
		"V1-c 内层 .sidebar-inner 宽度跟用户值（不是 100%）",
		Math.abs(m.innerWidth - SIDEBAR_MAX_WIDTH) < 1,
		`实测 ${m.innerWidth}px（push 式折叠动画依赖它）`,
	);

	// 折叠中：过渡必须还在动（width 未瞬间归零）
	await page.evalJs(TOGGLE_COLLAPSE);
	await sleep(80);
	const mid = JSON.parse(await page.evalJs(MEASURE));
	check(
		"V1-d 折叠过渡仍在进行（width 介于 0 与用户值之间）",
		mid.sidebarWidth > 0.5 && mid.sidebarWidth < expectedWide - 0.5,
		`点后 80ms 实测 ${mid.sidebarWidth}px（若非 0~${expectedWide} 之间 = min() 破坏了过渡）`,
	);
	await sleep(600);
	m = JSON.parse(await page.evalJs(MEASURE));
	check("V1-e 折叠态 width = 0", m.collapsed && m.sidebarWidth < 0.5, `实测 ${m.sidebarWidth}px`);
	check(
		"V1-f 折叠态不画分界发丝线",
		await page.evalJs(`getComputedStyle(document.querySelector(".sidebar"), "::after").display === "none"`),
		"`.is-collapsed::after { display: none }` 生效",
	);

	// 再展开：回到用户值
	await page.evalJs(TOGGLE_COLLAPSE);
	await sleep(700);
	m = JSON.parse(await page.evalJs(MEASURE));
	check(
		"V1-g 展开后回到夹紧值（不是 240）",
		!m.collapsed && Math.abs(m.sidebarWidth - expectedWide) < 1,
		`实测 ${m.sidebarWidth}px，期望 ${expectedWide}px`,
	);

	// 窄窗：min() 夹紧生效，聊天列不被挤没
	const before = JSON.parse(await page.evalJs(MEASURE));
	await page.evalJs(RESIZE_WINDOW(640, 620));
	await sleep(700);
	m = JSON.parse(await page.evalJs(MEASURE));
	const expectedNarrow = Math.min(SIDEBAR_MAX_WIDTH, m.parentWidth - CHAT_MIN_WIDTH);
	check(
		"V1-h 窄窗（640）侧栏被 min() 夹紧",
		Math.abs(m.sidebarWidth - expectedNarrow) < 1 && expectedNarrow < SIDEBAR_MAX_WIDTH,
		`实测 ${m.sidebarWidth}px，期望 ${expectedNarrow}px（容器 ${m.parentWidth}px）`,
	);
	check(
		"V1-i 窄窗聊天列 ≥ 320px（不被挤没）",
		m.chatWidth >= CHAT_MIN_WIDTH - 1,
		`实测 ${m.chatWidth?.toFixed(1)}px`,
	);
	check(
		"V1-j 无横向滚动条",
		m.docScrollWidth <= m.docClientWidth + 1,
		`scrollWidth ${m.docScrollWidth} vs clientWidth ${m.docClientWidth}`,
	);

	// 还原窗口
	await page.evalJs(RESIZE_WINDOW(before.parentWidth, 750));
	await sleep(700);
	m = JSON.parse(await page.evalJs(MEASURE));
	check(
		"V1-k 窗口放大后侧栏回到 480（夹紧是动态的）",
		Math.abs(m.sidebarWidth - SIDEBAR_MAX_WIDTH) < 1,
		`实测 ${m.sidebarWidth}px`,
	);
	await page.evalJs(SET_WIDTH(SIDEBAR_DEFAULT_WIDTH));
	await sleep(600);
}

/* ---------------- V2：拖动期关过渡不跳帧 ---------------- */
async function dispatchMouse(page, type, x, y, extra = {}) {
	await page.send("Input.dispatchMouseEvent", {
		type,
		x,
		y,
		button: "left",
		clickCount: type === "mouseMoved" ? 0 : 1,
		...extra,
	});
}

async function dragOnce(page, { handleX, y, steps, disableTransition, isProbe }) {
	if (isProbe) {
		await page.evalJs(`(() => { window.__lfDrag.disableTransition = ${disableTransition}; return true; })()`);
	}
	// 先挪开再挪回：CDP 对同一坐标的 mouseMoved 不重算 hover（见 AGENTS.md 鼠标交互坑）
	await dispatchMouse(page, "mouseMoved", 5, y - 60);
	await dispatchMouse(page, "mouseMoved", handleX, y);
	await sleep0();
	await dispatchMouse(page, "mousePressed", handleX, y, { buttons: 1 });
	await page.evalJs(SETTLE);

	const samples = [];
	let x = handleX;
	for (const step of steps) {
		x = handleX + step;
		await dispatchMouse(page, "mouseMoved", x, y, { buttons: 1 });
		await page.evalJs(SETTLE);
		const m = JSON.parse(await page.evalJs(MEASURE));
		samples.push({
			step,
			measured: m.sidebarWidth,
			target: Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, SIDEBAR_DEFAULT_WIDTH + step)),
			clampedTarget: Math.min(
				Math.max(SIDEBAR_MIN_WIDTH, SIDEBAR_DEFAULT_WIDTH + step),
				Math.min(SIDEBAR_MAX_WIDTH, m.parentWidth - CHAT_MIN_WIDTH),
			),
			chatWidth: m.chatWidth,
		});
	}
	await dispatchMouse(page, "mouseReleased", x, y, { buttons: 0 });
	const atRelease = JSON.parse(await page.evalJs(MEASURE_AFTER_SETTLE));
	await sleep(500);
	const settled = JSON.parse(await page.evalJs(MEASURE));
	const moves = isProbe ? await page.evalJs("window.__lfDrag.moves") : null;
	return { samples, atRelease, settled, moves, endX: x };
}

async function v2Drag(page, { isProbe }) {
	console.log(`\n=== V2 拖动期关过渡（${isProbe ? "注入探针把手，阶段 0" : "真实把手"}）===`);
	const y = 300;
	await page.evalJs(RESET_DRAG_STATE);
	await page.evalJs(SET_WIDTH(SIDEBAR_DEFAULT_WIDTH));
	await sleep(600);

	const geom = JSON.parse(
		await page.evalJs(`(() => {
			const h = document.querySelector("[data-sidebar-resize-handle]");
			const r = h.getBoundingClientRect();
			return JSON.stringify({ handleX: r.left + r.width / 2, handleW: r.width, sidebarW: r.right });
		})()`),
	);
	console.log(`  把手命中区宽 ${geom.handleW}px，中心 x = ${geom.handleX}`);

	const steps = [];
	for (let s = 20; s <= 200; s += 20) steps.push(s);

	// ① 关过渡（is-resizing / 真实实现固定如此）
	const off = await dragOnce(page, {
		handleX: geom.handleX,
		y,
		steps,
		disableTransition: true,
		isProbe,
	});
	const lagOf = (run) => Math.max(...run.samples.map((s) => Math.abs(s.measured - s.clampedTarget)));
	const offLag = lagOf(off);
	check(
		"V2-a 拖动中宽度与指针同步（滞后 ≤ 8px）",
		offLag <= 8,
		`最大滞后 ${offLag.toFixed(1)}px（${off.samples.length} 步 × 20px）`,
	);
	check(
		"V2-b 拖动中聊天列始终 ≥ 320px",
		off.samples.every((s) => s.chatWidth >= CHAT_MIN_WIDTH - 1),
		`最小 ${Math.min(...off.samples.map((s) => s.chatWidth)).toFixed(1)}px`,
	);
	check(
		"V2-c 松手后无追赶动画（宽度不再变化）",
		Math.abs(off.settled.sidebarWidth - off.atRelease.sidebarWidth) < 2,
		`松手 ${off.atRelease.sidebarWidth}px → 500ms 后 ${off.settled.sidebarWidth}px`,
	);
	check(
		"V2-d 松手后过渡已恢复（is-resizing 摘掉）",
		await page.evalJs(
			`!document.querySelector(".sidebar").classList.contains("is-resizing") && getComputedStyle(document.querySelector(".sidebar")).transitionDuration !== "0s"`,
		),
		"transitionDuration 非 0s",
	);
	check(
		"V2-e 拖动中 body 光标 = col-resize（松手已还原）",
		(await page.evalJs("document.body.style.cursor")) === "",
		"松手后 body cursor 为空",
	);

	// ② 对照组：不关过渡（只有探针模式可构造）—— 用来证明决策必要
	if (isProbe) {
		await page.evalJs(SET_WIDTH(SIDEBAR_DEFAULT_WIDTH));
		await sleep(700);
		const on = await dragOnce(page, {
			handleX: geom.handleX,
			y,
			steps,
			disableTransition: false,
			isProbe,
		});
		const onLag = lagOf(on);
		console.log(
			`  对照组（**不关**过渡）：最大滞后 ${onLag.toFixed(1)}px，` +
				`松手 2 帧内 ${on.atRelease.sidebarWidth}px、500ms 后 ${on.settled.sidebarWidth}px`,
		);
		check(
			"V2-f 对照组证实「关过渡」确有必要（不关时滞后明显更大）",
			onLag > offLag + 5,
			`关过渡 ${offLag.toFixed(1)}px vs 不关 ${onLag.toFixed(1)}px`,
		);
	} else {
		skip("V2-f 对照组", "真实把手固定关过渡，对照组只能由探针构造（阶段 0 已测）");
	}

	// 复位
	await page.evalJs(SET_WIDTH(SIDEBAR_DEFAULT_WIDTH));
	await sleep(700);
	const back = JSON.parse(await page.evalJs(MEASURE));
	check(
		"V2-g 复位：拖完设回 240 后宽度跟随",
		Math.abs(back.sidebarWidth - SIDEBAR_DEFAULT_WIDTH) < 1,
		`实测 ${back.sidebarWidth}px`,
	);
}

/* ---------------- V3：window.resizeTo → main 侧 resize → 落盘 ---------------- */
const MAIN_INSTALL = `(() => {
	const { BrowserWindow } = process.mainModule.require("electron");
	const win = BrowserWindow.getAllWindows()[0];
	globalThis.__lf = { events: [], before: win.getBounds(), normalBefore: win.getNormalBounds() };
	const push = (type) => () => globalThis.__lf.events.push({ type, at: Date.now() });
	win.on("resize", () => globalThis.__lf.events.push({ type: "resize", at: Date.now(), bounds: win.getBounds() }));
	win.on("move", push("move"));
	win.on("resized", push("resized"));
	win.on("moved", push("moved"));
	return JSON.stringify(globalThis.__lf);
})()`;

const MAIN_READ = `(() => {
	const { BrowserWindow } = process.mainModule.require("electron");
	const win = BrowserWindow.getAllWindows()[0];
	return JSON.stringify({
		events: globalThis.__lf.events,
		bounds: win.getBounds(),
		normalBounds: win.getNormalBounds(),
		maximized: win.isMaximized(),
		before: globalThis.__lf.before,
	});
})()`;

const MAIN_RESTORE = `(() => {
	const { BrowserWindow } = process.mainModule.require("electron");
	const win = BrowserWindow.getAllWindows()[0];
	win.setBounds(globalThis.__lf.before);
	return JSON.stringify(win.getBounds());
})()`;

async function v3Bounds(page) {
	console.log("\n=== V3 window.resizeTo → main 侧 resize → 落盘 ===");
	let main;
	try {
		main = await connect(MAIN_PORT, (t) => t.webSocketDebuggerUrl);
		await main.send("Runtime.enable");
	} catch (error) {
		skip("V3 主进程探针", `${error.message}（dev 未带 --inspect=${MAIN_PORT}？）`);
		return;
	}
	const start = JSON.parse(await main.evalJs(MAIN_INSTALL));
	console.log(
		`  主进程窗口起始：${JSON.stringify(start.before)}（normal ${JSON.stringify(start.normalBefore)}）`,
	);

	const target = { width: 900, height: 620 };
	await page.evalJs(RESIZE_WINDOW(target.width, target.height));
	const pageSize = await page.evalJs("[window.outerWidth, window.outerHeight]");
	await sleep(BOUNDS_SAVE_DEBOUNCE_MS + 800);
	const after = JSON.parse(await main.evalJs(MAIN_READ));

	const resizes = after.events.filter((e) => e.type === "resize");
	check(
		"V3-a window.resizeTo 真改了窗口尺寸（renderer 视角）",
		Math.abs(pageSize[0] - target.width) <= 20 && Math.abs(pageSize[1] - target.height) <= 20,
		`outerWidth/Height = ${pageSize.join("×")}，目标 ${target.width}×${target.height}`,
	);
	check(
		"V3-b main 进程收到 resize 事件（防抖写盘的地基）",
		resizes.length >= 1,
		`resize × ${resizes.length}（另有 move ${after.events.filter((e) => e.type === "move").length} / ` +
			`moved ${after.events.filter((e) => e.type === "moved").length} / resized ${after.events.filter((e) => e.type === "resized").length}）`,
	);
	check(
		"V3-c getNormalBounds() 读到新尺寸（写盘数据源正确）",
		Math.abs(after.normalBounds.width - target.width) <= 20 &&
			Math.abs(after.normalBounds.height - target.height) <= 20,
		`normalBounds = ${JSON.stringify(after.normalBounds)}`,
	);

	let saved = null;
	try {
		saved = JSON.parse(readFileSync(DEV_UI_STATE, "utf8"));
	} catch (error) {
		console.log(`  （读 dev ui-state.json 失败：${error.message}）`);
	}
	const bounds = saved?.windowBounds ?? null;
	if (STAGE0) {
		skip(
			"V3-d dev ui-state.json 落盘 windowBounds",
			`阶段 0 尚无写盘代码（--stage0 记 SKIP，阶段 2 复核）；当前文件值 = ${JSON.stringify(bounds)}`,
		);
	} else {
		check(
			"V3-d dev ui-state.json 落盘 windowBounds ≈ 900×620",
			!!bounds &&
				Math.abs(bounds.width - target.width) <= 20 &&
				Math.abs(bounds.height - target.height) <= 20,
			`文件值 = ${JSON.stringify(bounds)}`,
		);
	}

	const restored = JSON.parse(await main.evalJs(MAIN_RESTORE));
	console.log(`  还原窗口 → ${JSON.stringify(restored)}`);
	await sleep(600);
	main.close();
}

/* ---------------- 主流程 ---------------- */
const mode = process.argv[2] ?? "all";
const page = await connect(PAGE_PORT, (t) => t.type === "page" && t.webSocketDebuggerUrl);
await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });

// 真实 CSS / 真实把手是否已存在（阶段 1 之后为真）
const followsVar = await page.evalJs(DETECT_REAL_CSS);
const injectedCss = Math.abs(followsVar - 300) > 1;
if (injectedCss) await page.evalJs(INJECT_CSS);
const handleKind = await page.evalJs(INSTALL_PROBE_HANDLE);
const isProbe = handleKind === "probe";
console.log(
	`环境：候选 CSS ${injectedCss ? "未落地 → 注入探针样式" : "已落地"}；把手 ${isProbe ? "未落地 → 注入探针" : "真实"}`,
);

try {
	if (mode === "v1-css" || mode === "all") await v1Css(page, { injectedCss });
	if (mode === "v2-drag" || mode === "all") await v2Drag(page, { isProbe });
	if (mode === "v3-bounds" || mode === "all") await v3Bounds(page);
} finally {
	await page.evalJs(CLEANUP);
	page.close();
}

const fail = results.filter((r) => r.status === "FAIL");
const pass = results.filter((r) => r.status === "PASS");
const skipped = results.filter((r) => r.status === "SKIP");
console.log(
	`\n合计 ${results.length} 条：PASS ${pass.length} / FAIL ${fail.length} / SKIP ${skipped.length}` +
		(fail.length ? `\n失败项：\n${fail.map((f) => `  - ${f.name}：${f.detail}`).join("\n")}` : ""),
);
process.exit(fail.length ? 1 : 0);
