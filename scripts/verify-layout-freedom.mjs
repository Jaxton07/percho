/**
 * layout-freedom 验收脚本（spec `.local/agent-work/spec/layout-freedom.md` §9 的 V1/V2/V3 + REVIEW R1 的夹紧断言）
 *
 * 前置：dev 应用带**两个**调试端口运行（页面 9224 + 主进程 9229，主进程探针需要它）：
 *   cd packages/desktop && npx electron-vite dev -- --remote-debugging-port=9224 --inspect=9229
 *   （注意：`npm run dev -- --xxx` 不行，npm 会把参数当自己的 config 吞掉）
 *
 * 用法：
 *   node scripts/verify-layout-freedom.mjs all [--stage0]      # V1 宽度方案 + V2 拖动 + V3 窗口事件/落盘
 *   node scripts/verify-layout-freedom.mjs v1-css|v2-drag|v3-bounds|v4-window|v5-frames
 *   `--stage0`：阶段 0 语义 —— V3 的「落盘 windowBounds」这一环尚不存在（阶段 2 才写），
 *   该子断言记 SKIP 而不是 FAIL。阶段 2 之后不加该参数，端到端必须真绿。
 *
 *   node scripts/verify-layout-freedom.mjs v6-handle [--expect-handle-bug]
 *   V6：真实 store 列表触发 useEdgeFade，扫描整段把手命中；阶段 0 加 --expect-handle-bug
 *   验证原始遮挡 + 临时 z-index:1，修复后不加参数验真实 CSS。夹具/样式/窗口均恢复。
 *
 *   `v4-window` 会**主动退出 dev**（验证退出兜底同步写），所以必须放在最后跑、跑完重启 dev；
 *   `v5-frames` 是 R5 的观察项（连续缩放窗口时的帧间隔），只报数不判定。
 *
 * 断言各自的用意：
 *   V1 宽度方案：`--sidebar-render-width`（renderer 派生的**渲染宽**）能否与既有 400ms 过渡、
 *      `.is-collapsed { width: 0 }` 源序覆盖共存；**R1 的核心**是窄窗下内外层是否吃同一个值 ——
 *      外层夹紧而内层不夹时，`.sidebar-inner` 右侧会被 overflow:hidden 硬裁，被裁的正是行末那些
 *      功能控件（项目操作 ⋯ / 添加项目 / 在项目中新建会话）。断言 = 窄窗 `innerOverflowPx === 0`
 *      且侧栏内**没有任何**控件越过侧栏右缘。
 *   V2 拖动期「关过渡（is-resizing）+ 松手恢复」是否跳帧/落后于指针；顺带跑一遍**不关过渡**的对照组，
 *     用实测滞后量证明这条决策的必要性；也回答「松手后是否有一段 0.4s 追赶动画」。
 *   V3 `window.resizeTo` 是否会让 main 进程收到 `resize`（→ 阶段 2 的防抖写盘才能端到端自动化）。
 *     主进程侧探针经 9229 的 Node inspector 注入（`process.mainModule.require('electron')`），
 *     **不改生产代码**；探针只在内存里，进程退出即消失。
 *
 * 自动降级：真实 CSS（`--sidebar-render-width` 生效）与真实把手 `[data-sidebar-resize-handle]` 落地后用真实实现；
 * 都没落地才注入候选 CSS + 探针把手（阶段 0 的用法，收尾会清干净）。真实模式下改宽度只能靠**拖把手**
 * （store 没有对外出口），所以脚本会先把窗口放宽到容器 ≥ 800px 保证「渲染宽 == 用户意图值」。
 *
 * 已知坑（本脚本踩过两次，正在写事件序列时很容易再踩）：
 *  - CDP `Page.captureScreenshot` 会打断**进行中**的指针捕获：之后 `pointermove` 不再进把手、
 *    `pointerup` 也丢，拖动态就永久卡在 is-resizing（后续拖动全部失效）。所以：**量测通道一律不截图**，
 *    截图通道放最后，且每次拖完都在**把手当前位置**补一次 release 兜底（recoverDrag）。
 *  - 松手坐标跑出视口（x < 0，拖到最左时会发生）同样丢 pointerup。所以松手一律回当前把手中心，不回指针终点。
 *
 * 副作用：会给 dev 的 `ui-state.json` 写侧栏宽度（阶段 2 后还会写窗口 bounds，见 REVIEW R2）——
 * 手测「重启保持」前先备份该文件。截图落在 `.local/tmp/layout-freedom/`（CDP 截图，不用系统截图）。
 *
 * 退出码：0 全绿 / 1 有断言失败 / 2 环境不满足（端口不通等）。
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PAGE_PORT = process.env.CDP_PORT ?? "9224";
const MAIN_PORT = process.env.CDP_MAIN_PORT ?? "9229";
const DEV_UI_STATE = join(homedir(), "Library/Application Support/@percho/desktop-dev/ui-state.json");
const OUT_DIR = ".local/tmp/layout-freedom";
const STAGE0 = process.argv.includes("--stage0");
mkdirSync(OUT_DIR, { recursive: true });

/** 侧栏宽度常量（与 shared `src/sidebar.ts` 一致；本脚本只做探测，不 import 生产代码） */
const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;
const CHAT_MIN_WIDTH = 320;
/** 阶段 2 的防抖窗口（spec §5.1） */
const BOUNDS_SAVE_DEBOUNCE_MS = 400;
/** 宽窗基准：容器 ≥ 800px 时渲染宽 == 用户意图值（480 + 320） */
const WIDE_WINDOW = { width: 1100, height: 750 };
const NARROW_WINDOW = { width: 640, height: 620 };
const DRAG_Y = 300;

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
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error(`连接 ${url} 失败`));
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
				const desc = res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails);
				throw new Error(`页面内执行失败：${desc}`);
			}
			return res.result?.value;
		},
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 页面侧片段 ---------------- */
const SETTLE = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;
/** 等 2 个 rAF（React flush + 过渡创建）再取样 */
const measureExpr = (extra = "") =>
	`(() => { const sb = document.querySelector(".sidebar"); const parent = sb.parentElement; const chat = parent.children[1];
	const rect = sb.getBoundingClientRect(); const inner = sb.querySelector(".sidebar-inner").getBoundingClientRect();
	const controls = [...sb.querySelectorAll("button, a, input, select, textarea, [role='button']")];
	const clipped = controls
		.filter((el) => { const r = el.getBoundingClientRect(); return (r.width > 0 || r.height > 0) && (r.right > rect.right + 1 || r.left < rect.left - 1); })
		.map((el) => ({ label: ((el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)), right: Math.round(el.getBoundingClientRect().right) }));
	return JSON.stringify({
		collapsed: sb.classList.contains("is-collapsed"),
		resizing: sb.classList.contains("is-resizing"),
		sidebarWidth: parseFloat(getComputedStyle(sb).width),
		rectRight: Math.round(rect.right),
		innerWidth: inner.width,
		innerOverflowPx: Math.round((inner.width - rect.width) * 10) / 10,
		parentWidth: parent.clientWidth,
		chatWidth: chat ? chat.getBoundingClientRect().width : null,
		varValue: sb.style.getPropertyValue("--sidebar-render-width"),
		handleCount: sb.querySelectorAll("[data-sidebar-resize-handle]").length,
		scannedControls: controls.length,
		clippedControls: clipped,
		docScrollWidth: document.documentElement.scrollWidth,
		docClientWidth: document.documentElement.clientWidth,
		${extra}
	});
})()`;

const MEASURE_AFTER_SETTLE = `(async () => { await ${SETTLE}; return ${measureExpr()}; })()`;

/** 候选 CSS（生产代码未落地时的探针写法；与 docs 里的最终方案同构） */
const CANDIDATE_CSS = `
.sidebar { width: var(--sidebar-render-width, 240px); }
.sidebar-inner { width: var(--sidebar-render-width, 240px); }
.sidebar.is-resizing { transition: none; }
`;

const INJECT_CSS = `(() => {
	let el = document.getElementById("lf-probe-css");
	if (!el) { el = document.createElement("style"); el.id = "lf-probe-css"; document.head.append(el); }
	el.textContent = ${JSON.stringify(CANDIDATE_CSS)};
	return true;
})()`;

/** 真实 CSS 是否已落地（直接看 CSSOM 里 `.sidebar` 的 width 用没用渲染宽变量）。
 *  不用「写变量读 computed width」探测：同一任务里刚写的自定义属性可能还没进这次 style 解析，
 *  读到的是旧值（实测踩过，会误判成「未落地」）。 */
const DETECT_REAL_CSS = `(() => {
	for (const sheet of document.styleSheets) {
		let rules;
		try { rules = sheet.cssRules; } catch { continue; }
		for (const rule of rules) {
			if (rule.selectorText === ".sidebar" && /--sidebar-render-width/.test(rule.style.getPropertyValue("width"))) return true;
		}
	}
	return false;
})()`;

/** 探针把手（只在生产实现未落地时安装；内联模拟「renderer 派生渲染宽 → 一个变量喂内外层」） */
const INSTALL_PROBE_HANDLE = `(() => {
	const existing = document.querySelector('[data-sidebar-resize-handle="probe"]');
	if (existing) return "probe";
	if (document.querySelector("[data-sidebar-resize-handle]")) return "real";
	const sb = document.querySelector(".sidebar");
	const handle = document.createElement("hr");
	handle.setAttribute("data-sidebar-resize-handle", "probe");
	handle.style.cssText = "position:absolute;top:0;bottom:0;right:0;width:8px;margin:0;border:0;cursor:col-resize;z-index:50;";
	sb.append(handle);
	const clamp = (v) => Math.max(${SIDEBAR_MIN_WIDTH}, Math.min(${SIDEBAR_MAX_WIDTH}, Math.round(v)));
	const probe = { userWidth: ${SIDEBAR_DEFAULT_WIDTH}, disableTransition: true, moves: 0 };
	const apply = () => {
		const container = sb.parentElement.clientWidth;
		const render = Math.max(${SIDEBAR_MIN_WIDTH}, Math.min(probe.userWidth, container - ${CHAT_MIN_WIDTH}));
		sb.style.setProperty("--sidebar-render-width", render + "px");
	};
	probe.apply = apply;
	probe.setUserWidth = (value) => { probe.userWidth = clamp(value); apply(); };
	probe.resizeHandler = apply;
	window.__lfProbe = probe;
	window.addEventListener("resize", apply);
	let dragging = false, startX = 0, startUser = ${SIDEBAR_DEFAULT_WIDTH};
	const finish = () => {
		if (!dragging) return;
		dragging = false;
		sb.classList.remove("is-resizing");
		document.body.style.cursor = "";
	};
	handle.addEventListener("pointerdown", (e) => {
		dragging = true;
		startX = e.clientX;
		startUser = probe.userWidth;
		if (probe.disableTransition) sb.classList.add("is-resizing");
		handle.setPointerCapture(e.pointerId);
		document.body.style.cursor = "col-resize";
		e.preventDefault();
	});
	handle.addEventListener("pointermove", (e) => {
		if (!dragging) return;
		probe.moves++;
		probe.setUserWidth(startUser + (e.clientX - startX));
	});
	handle.addEventListener("pointerup", finish);
	handle.addEventListener("pointercancel", finish);
	apply();
	return "probe";
})()`;

/** 只复位拖动态（探针把手/样式保留） */
const RESET_DRAG_STATE = `(() => {
	const sb = document.querySelector(".sidebar");
	if (sb) sb.classList.remove("is-resizing");
	document.body.style.cursor = "";
	return true;
})()`;

/** 收尾：探针把手、探针样式、监听器全清掉 */
const CLEANUP = `(() => {
	const probe = window.__lfProbe;
	if (probe?.resizeHandler) window.removeEventListener("resize", probe.resizeHandler);
	document.querySelector('[data-sidebar-resize-handle="probe"]')?.remove();
	document.getElementById("lf-probe-css")?.remove();
	window.__lfProbe = undefined;
	return true;
})()`;

const RESIZE_WINDOW = (w, h) =>
	`(() => { window.resizeTo(${w}, ${h}); return [window.outerWidth, window.outerHeight]; })()`;

const HANDLE_GEOM = `(() => {
	const handle = document.querySelector("[data-sidebar-resize-handle]");
	const r = handle.getBoundingClientRect();
	return JSON.stringify({ x: r.left + r.width / 2, width: r.width, sidebarRight: r.right });
})()`;

/** 分界发丝线的当前样式（用它证明「可见反馈复用同一条线」，而不是新增了第二条竖线） */
const LINE_STYLE = `(() => {
	const cs = getComputedStyle(document.querySelector(".sidebar"), "::after");
	return JSON.stringify({ width: cs.width, display: cs.display, background: cs.backgroundImage });
})()`;

const TOGGLE_SIDEBAR = `(() => {
	const btn = [...document.querySelectorAll("button")].find((b) => /导航栏|sidebar/i.test(b.getAttribute("aria-label") || ""));
	if (!btn) throw new Error("没找到顶栏最左的左栏开合按钮");
	btn.click();
	return true;
})()`;

/**
 * 命中层探针（X2 回归）：检查侧栏里**真正可见**的可交互元素有没有被**栏外**的东西盖住。
 *
 * 为什么要有它：聊天列里比列宽更宽的内容（聊天页空态的 748px logo 块）会向两侧溢出，**溢出的透明部分
 * 照样吃 pointer 事件** —— 实测侧栏 480 时整条右缘 82px 变成点击死区（把手也抓不住），而截图完全看不出来。
 *
 * 两条判据（2026-10-07 第一版判据误报后修正，见 IMPL-NOTES X2）：
 *  1. 预筛「未被祖先裁掉」：元素中心若落在某个 `overflow != visible` 的祖先盒外（折叠分组 `0fr` + `hidden`、
 *     滚动出可视区），它本来就不可见 —— 那不是遮挡，跳过；
 *  2. 判据用 `sb.contains(top)` 而**不是** `top === el`：栏内自己那层（行尾 hover 才显示的 ⋯ 可能带
 *     `pointer-events: none`）不算遮挡，只有**来自栏外**的元素才算 —— 正是 X2 的形状。
 */
const HIT_STACK = `(() => {
	const sb = document.querySelector(".sidebar");
	const handle = document.querySelector("[data-sidebar-resize-handle]");
	const sbRect = sb.getBoundingClientRect();
	const hr = handle.getBoundingClientRect();
	const topAtHandle = document.elementsFromPoint(Math.round(hr.left + hr.width / 2), Math.round(hr.top + hr.height / 2))[0];
	const describe = (el) => (el ? el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.split(/\\s+/).filter(Boolean).slice(0, 2).join(".") : "") : "null");
	const clippedByAncestor = (el, x, y) => {
		let node = el.parentElement;
		while (node && node !== document.body) {
			const cs = getComputedStyle(node);
			if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
				const r = node.getBoundingClientRect();
				if (x < r.left || x > r.right || y < r.top || y > r.bottom) return true;
			}
			node = node.parentElement;
		}
		return false;
	};
	const controls = [...sb.querySelectorAll("button, a, input, select, textarea, [role='button']")];
	let visibleScanned = 0;
	const blocked = [];
	for (const el of controls) {
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) continue;
		const x = Math.round(r.left + r.width / 2);
		const y = Math.round(r.top + r.height / 2);
		if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
		if (clippedByAncestor(el, x, y)) continue;
		visibleScanned++;
		const top = document.elementFromPoint(x, y);
		if (!(top && sb.contains(top))) {
			blocked.push({
				label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 20),
				right: Math.round(r.right),
				top: describe(top),
				topOutsideSidebar: !!top && !sb.contains(top),
			});
		}
	}
	return JSON.stringify({
		topAtHandle: describe(topAtHandle),
		topIsHandle: topAtHandle === handle || handle.contains(topAtHandle),
		scannedControls: controls.length,
		visibleScanned,
		blocked,
	});
})()`;

const IS_COLLAPSED = `document.querySelector(".sidebar").classList.contains("is-collapsed")`;

/**
 * 钉住 / 解除把手的 `:hover` 伪类（CDP `CSS.forcePseudoState`）。
 * 为什么要它：真实 hover 会被 `Page.captureScreenshot` 打断（截图前后 `:hover` 链可能被清掉，
 * 且对同一坐标再发 `mouseMoved` 不重算）→ hover 态截图时有时无。强制伪类走的是同一个样式引擎，
 * 且**截图不会把它清掉**，所以「hover 截图」是确定性的。
 */
async function forceHandleHover(page, on) {
	const { root } = await page.send("DOM.getDocument", { depth: 1 });
	const { nodeId } = await page.send("DOM.querySelector", {
		nodeId: root.nodeId,
		selector: "[data-sidebar-resize-handle]",
	});
	await page.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: on ? ["hover"] : [] });
}

/** 截图（空白帧按体积重试）：clip 单位 CSS px，输出像素 = clip × DPR */
async function shot(page, name, clip, attempts = 4) {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const { data } = await page.send("Page.captureScreenshot", { format: "png", clip });
		const buf = Buffer.from(data, "base64");
		if (buf.length > 12000) {
			writeFileSync(join(OUT_DIR, `${name}.png`), buf);
			console.log(`  📸 ${name}.png${attempt > 1 ? `（第 ${attempt} 次成功）` : ""}`);
			return;
		}
		await sleep(160);
	}
	console.log(`  📸 ${name}.png ⚠ ${attempts} 次都是空白帧，已跳过`);
}

/* ---------------- 鼠标（真实输入管线：pointer capture 才能生效） ---------------- */
async function dispatchMouse(page, type, x, y, extra = {}) {
	// `button` 必须与 `buttons` 一致：moved 且 buttons=0 时要给 `"none"`，否则 Chromium 会把这次 move 当成
	// 「左键仍按着」（实测：`button:"left" + buttons:0` 送出的 pointermove 里 `buttons` 仍是 1，
	// 于是 X3 的「松手丢失后靠 buttons===0 自愈」这条测不出来 —— 差点误判成产品 bug）
	const buttons = extra.buttons ?? (type === "mouseMoved" ? 0 : 1);
	await page.send("Input.dispatchMouseEvent", {
		type,
		x,
		y,
		button: type === "mouseMoved" && buttons === 0 ? "none" : "left",
		clickCount: type === "mouseMoved" ? 0 : 1,
		buttons,
		...extra,
	});
}

/** 拖把手：从当前位置拖 delta 像素（真实模式与探针模式同一套驱动） */
/** 把手当前中心坐标（拖到尽头后把手会跟着走，收尾要重新取） */
async function handleCenter(page) {
	const geom = JSON.parse(await page.evalJs(HANDLE_GEOM));
	return { x: Math.max(1, Math.round(geom.x)), sidebarRight: geom.sidebarRight };
}

/**
 * 收尾：把可能残留的拖动态（指针捕获丢了、`pointerup` 没落到把手上）清干净。
 * 手法 = 在**把手当前位置**上补一次 release：有捕获就到把手，没捕获时那个坐标也落在把手命中区里。
 * 返回 true = 连补 release 都没用（已直接摘类，只影响视觉，不影响宽度值）。
 */
async function recoverDrag(page) {
	const stuckOf = `document.querySelector(".sidebar").classList.contains("is-resizing")`;
	if (!(await page.evalJs(stuckOf))) return false;
	const center = await handleCenter(page);
	await dispatchMouse(page, "mouseMoved", center.x, DRAG_Y);
	await dispatchMouse(page, "mouseReleased", center.x, DRAG_Y, { buttons: 0 });
	await sleep(250);
	if (!(await page.evalJs(stuckOf))) return false;
	await page.evalJs(RESET_DRAG_STATE);
	return true;
}

async function dragBy(page, delta, { y = DRAG_Y, steps = 1, between } = {}) {
	const geom = JSON.parse(await page.evalJs(HANDLE_GEOM));
	// 先挪开再挪回：CDP 对同一坐标的 mouseMoved 不重算 hover（见 AGENTS.md 鼠标交互坑）
	await dispatchMouse(page, "mouseMoved", 5, y - 60);
	await dispatchMouse(page, "mouseMoved", Math.max(1, Math.round(geom.x)), y);
	await sleep(60);
	await dispatchMouse(page, "mousePressed", Math.max(1, Math.round(geom.x)), y, { buttons: 1 });
	// 预热：等 React 把 `is-resizing`（关过渡）提交完再开始量 —— 第一步若抢在同一帧里，
	// 过渡还没关，会量出一次假滞后（2026-10-07 首次在 HMR 后立刻跑 all 时误报过一次 40px）
	await page.evalJs(SETTLE);
	await page.evalJs(SETTLE);
	const step = delta / steps;
	const samples = [];
	for (let i = 1; i <= steps; i++) {
		await dispatchMouse(page, "mouseMoved", Math.round(geom.x + step * i), y, { buttons: 1 });
		await page.evalJs(SETTLE);
		samples.push({ step: step * i, measured: JSON.parse(await page.evalJs(measureExpr())).sidebarWidth });
		if (between) await between(i);
	}
	// 松手**回到把手当前位置**（不是指针终点）：指针终点可能跑出视口（x < 0）而丢掉 pointerup，
	// 那一丢就把拖动态永久卡住（踩过：后续拖动全部无效）
	const center = await handleCenter(page);
	await dispatchMouse(page, "mouseReleased", center.x, y, { buttons: 0 });
	const atRelease = JSON.parse(await page.evalJs(MEASURE_AFTER_SETTLE));
	await sleep(500);
	const settled = JSON.parse(await page.evalJs(measureExpr()));
	return { samples, atRelease, settled, geom, stuck: await recoverDrag(page) };
}

/**
 * 把「用户意图宽」设成 px。
 * - 探针模式：直接写探针的 userWidth（等价于 renderer 的 store 写入）。
 * - 真实模式：store 没有对外出口，只能拖把手 —— 先保证窗口够宽（容器 ≥ 800 → 渲染宽 == 用户值），
 *   再按「当前渲染宽 → 目标」拖。拖完会真落盘（脚本副作用，见头部说明）。
 */
async function setUserWidth(page, px, { isProbe }) {
	if (isProbe) {
		await page.evalJs(`(() => { window.__lfProbe.setUserWidth(${px}); return true; })()`);
		return;
	}
	// 真实模式：store 没有对外出口，只能拖把手。指针不能跑出视口（x<1），一次拖不到位就再补一轮
	for (let attempt = 0; attempt < 4; attempt++) {
		const measured = JSON.parse(await page.evalJs(measureExpr()));
		const delta = px - measured.sidebarWidth;
		if (Math.abs(delta) < 1) return;
		await dragBy(page, Math.round(delta));
		await sleep(650);
	}
}

/* ---------------- V1：宽度方案（含 REVIEW R1 的夹紧断言） ---------------- */
async function v1Css(page, { isProbe }) {
	console.log(`\n=== V1 宽度方案（${isProbe ? "注入候选 CSS + 探针（阶段 0 用法）" : "真实 CSS"}）===`);
	await page.evalJs(RESET_DRAG_STATE);
	await page.evalJs(RESIZE_WINDOW(WIDE_WINDOW.width, WIDE_WINDOW.height));
	await sleep(500);
	if (await page.evalJs(IS_COLLAPSED)) {
		await page.evalJs(TOGGLE_SIDEBAR);
		await sleep(750);
	}

	// 常态（用户值 480）：外层夹紧值、内层与之一致
	await setUserWidth(page, SIDEBAR_MAX_WIDTH, { isProbe });
	await sleep(650);
	let m = JSON.parse(await page.evalJs(measureExpr()));
	const expectedWide = Math.min(SIDEBAR_MAX_WIDTH, m.parentWidth - CHAT_MIN_WIDTH);
	check(
		"V1-a 常态 computed width = min(480, 容器宽-320)",
		Math.abs(m.sidebarWidth - expectedWide) < 1,
		`实测 ${m.sidebarWidth}px，期望 ${expectedWide}px（容器 ${m.parentWidth}px，聊天列 ${m.chatWidth?.toFixed(1)}px）`,
	);
	check(
		"V1-b 内层与外层同宽（R1：内外层必须吃同一个渲染宽）",
		m.innerOverflowPx === 0,
		`外层 ${m.sidebarWidth}px / 内层 ${m.innerWidth}px（溢出 ${m.innerOverflowPx}px）`,
	);
	check("V1-c 常态聊天列 ≥ 320px", m.chatWidth >= CHAT_MIN_WIDTH - 1, `实测 ${m.chatWidth?.toFixed(1)}px`);
	check(
		"V1-d 常态无控件越过侧栏右缘",
		m.scannedControls > 0 && m.clippedControls.length === 0,
		m.clippedControls.length
			? `越界：${JSON.stringify(m.clippedControls)}`
			: `扫到 ${m.scannedControls} 个可交互元素，越界 0 个`,
	);

	// 折叠中：过渡必须还在动（width 未瞬间归零）
	await page.evalJs(TOGGLE_SIDEBAR);
	await sleep(80);
	const mid = JSON.parse(await page.evalJs(measureExpr()));
	check(
		"V1-e 折叠过渡仍在进行（width 介于 0 与用户值之间）",
		mid.sidebarWidth > 0.5 && mid.sidebarWidth < expectedWide - 0.5,
		`点后 80ms 实测 ${mid.sidebarWidth}px（若非 0~${expectedWide} 之间 = 变量写法破坏了过渡）`,
	);
	await sleep(600);
	m = JSON.parse(await page.evalJs(measureExpr()));
	check("V1-f 折叠态 width = 0", m.collapsed && m.sidebarWidth < 0.5, `实测 ${m.sidebarWidth}px`);
	check(
		"V1-g 折叠态不画分界发丝线、不渲染把手",
		await page.evalJs(
			`getComputedStyle(document.querySelector(".sidebar"), "::after").display === "none" && document.querySelectorAll(".sidebar [data-sidebar-resize-handle]").length === 0`,
		),
		"`.is-collapsed::after { display: none }` + 把手收起时不渲染",
	);

	// 再展开：回到用户值
	await page.evalJs(TOGGLE_SIDEBAR);
	await sleep(700);
	m = JSON.parse(await page.evalJs(measureExpr()));
	check(
		"V1-h 展开后回到夹紧值（不是 240）",
		!m.collapsed && Math.abs(m.sidebarWidth - expectedWide) < 1,
		`实测 ${m.sidebarWidth}px，期望 ${expectedWide}px`,
	);

	// 窄窗：R1 的核心 —— 内外层夹紧到同一值，功能控件一个都不能被裁
	await page.evalJs(RESIZE_WINDOW(NARROW_WINDOW.width, NARROW_WINDOW.height));
	await sleep(750);
	m = JSON.parse(await page.evalJs(measureExpr()));
	const expectedNarrow = Math.min(SIDEBAR_MAX_WIDTH, m.parentWidth - CHAT_MIN_WIDTH);
	check(
		"V1-i 窄窗（640）侧栏被夹紧",
		Math.abs(m.sidebarWidth - expectedNarrow) < 1 && expectedNarrow < SIDEBAR_MAX_WIDTH,
		`实测 ${m.sidebarWidth}px，期望 ${expectedNarrow}px（容器 ${m.parentWidth}px）`,
	);
	check(
		"V1-j【R1】窄窗内层无溢出（innerOverflowPx === 0）",
		m.innerOverflowPx === 0,
		`外层 ${m.sidebarWidth}px / 内层 ${m.innerWidth}px（溢出 ${m.innerOverflowPx}px）`,
	);
	check(
		"V1-k【R1】窄窗无控件被裁（越界控件 0 个）",
		m.scannedControls > 0 && m.clippedControls.length === 0,
		m.clippedControls.length
			? `越界：${JSON.stringify(m.clippedControls)}`
			: `扫到 ${m.scannedControls} 个可交互元素，越界 0 个`,
	);
	check(
		"V1-l 窄窗聊天列 ≥ 320px（不被挤没）",
		m.chatWidth >= CHAT_MIN_WIDTH - 1,
		`实测 ${m.chatWidth?.toFixed(1)}px`,
	);
	check(
		"V1-m 窄窗无横向滚动条",
		m.docScrollWidth <= m.docClientWidth + 1,
		`scrollWidth ${m.docScrollWidth} vs clientWidth ${m.docClientWidth}`,
	);
	await shot(page, "v1-narrow-640", { x: 0, y: 0, width: 640, height: 420, scale: 1 });

	// 放大回宽窗：渲染宽自动回到用户值
	await page.evalJs(RESIZE_WINDOW(WIDE_WINDOW.width, WIDE_WINDOW.height));
	await sleep(750);
	m = JSON.parse(await page.evalJs(measureExpr()));
	check(
		"V1-n 窗口放大后侧栏回到 480（夹紧是动态的）",
		Math.abs(m.sidebarWidth - SIDEBAR_MAX_WIDTH) < 1,
		`实测 ${m.sidebarWidth}px`,
	);

	await setUserWidth(page, SIDEBAR_DEFAULT_WIDTH, { isProbe });
	await sleep(650);
	m = JSON.parse(await page.evalJs(measureExpr()));
	check(
		"V1-o 复位到 240（默认行为）",
		Math.abs(m.sidebarWidth - SIDEBAR_DEFAULT_WIDTH) < 1,
		`实测 ${m.sidebarWidth}px`,
	);
}

/* ---------------- X3：收尾兜底（指针在窗口外松手 ⇒ pointerup 丢失） ---------------- */

/** 按下把手并拖到视口外，返回起始几何（三个场景共用的起手式） */
async function beginDragOut(page, { release = "none" } = {}) {
	await page.evalJs(RESET_DRAG_STATE);
	await recoverDrag(page);
	await setUserWidth(page, SIDEBAR_DEFAULT_WIDTH, { isProbe });
	await sleep(650);
	const geom = JSON.parse(await page.evalJs(HANDLE_GEOM));
	// 记下 pointerId，后面模拟「捕获丢失」要用
	await page.evalJs(`(() => {
		const h = document.querySelector("[data-sidebar-resize-handle]");
		h.addEventListener("pointerdown", (e) => { window.__lfPointerId = e.pointerId; }, true);
		return true;
	})()`);
	await dispatchMouse(page, "mouseMoved", 5, DRAG_Y - 60);
	await dispatchMouse(page, "mouseMoved", Math.round(geom.x), DRAG_Y);
	await sleep(80);
	await dispatchMouse(page, "mousePressed", Math.round(geom.x), DRAG_Y, { buttons: 1 });
	await page.evalJs(SETTLE);
	// 往左拖到视口外（x < 0）
	for (const x of [geom.x - 40, 20, -40, -80]) {
		await dispatchMouse(page, "mouseMoved", Math.max(-80, Math.round(x)), DRAG_Y, { buttons: 1 });
		await sleep(25);
	}
	if (release === "outside") {
		// 注意：CDP 发到视口外的 `mouseReleased` **仍会送达页面**（实测 window/handle 都收到 pointerup），
		// 所以它模拟不了真机「在窗口外松手」。真机复现要**完全不发 release**（release: "none"），
		// 这也正是 review 的 `repro-lostup.mjs` 的做法。
		await dispatchMouse(page, "mouseReleased", -80, DRAG_Y, { buttons: 0 });
		await sleep(200);
	}
	const state = JSON.parse(await page.evalJs(measureExpr()));
	return { geom, state };
}

/** 按下把手并在**窗口内**小幅拖动（隔离测试用：不出窗就不会有 Chromium 自己发的 cancel/lostcapture） */
async function beginDragInside(page, dx = 40) {
	await page.evalJs(RESET_DRAG_STATE);
	await recoverDrag(page);
	await setUserWidth(page, SIDEBAR_DEFAULT_WIDTH, { isProbe });
	await sleep(650);
	const geom = JSON.parse(await page.evalJs(HANDLE_GEOM));
	await dispatchMouse(page, "mouseMoved", 5, DRAG_Y + 40);
	await dispatchMouse(page, "mouseMoved", Math.round(geom.x), DRAG_Y);
	await sleep(80);
	await dispatchMouse(page, "mousePressed", Math.round(geom.x), DRAG_Y, { buttons: 1 });
	await page.evalJs(SETTLE);
	await dispatchMouse(page, "mouseMoved", Math.round(geom.x + dx), DRAG_Y, { buttons: 1 });
	await page.evalJs(SETTLE);
	const state = JSON.parse(await page.evalJs(measureExpr()));
	return { geom, dragging: state.resizing, x: Math.round(geom.x + dx) };
}

/** 场景 A：松手事件丢失 → 鼠标移回窗口（`buttons === 0` 的 move）必须自愈 */
async function scenarioLostPointerUp(page) {
	const { state: stuck } = await beginDragOut(page);
	for (const x of [40, 120, 200]) {
		await dispatchMouse(page, "mouseMoved", x, DRAG_Y, { buttons: 0 });
		await sleep(60);
	}
	await sleep(250);
	const healed = JSON.parse(await page.evalJs(measureExpr()));
	const cursorAfterHeal = await page.evalJs("document.body.style.cursor");
	const after = await dragBy(page, 80, { steps: 4 });
	return {
		stuckBefore: stuck.resizing,
		healed: !healed.resizing && cursorAfterHeal === "",
		canDragAfter: after.settled.sidebarWidth > healed.sidebarWidth + 40,
		widths: `${stuck.sidebarWidth} → ${healed.sidebarWidth} → ${after.settled.sidebarWidth}`,
	};
}

/**
 * 场景 B：指针捕获丢失（`lostpointercapture`）必须立刻收尾。
 * 为什么要**派发合成事件**而不是调 `releasePointerCapture()`：实测 Chromium 里脚本调用它只把捕获丢掉、
 * **不触发** `lostpointercapture`（那种情况下靠 `buttons === 0` 的 move 兜）。这里测的是**处理器接线**。
 */
async function scenarioLostPointerCapture(page) {
	const { dragging, x } = await beginDragInside(page);
	const dispatched = await page.evalJs(`(() => {
		const h = document.querySelector("[data-sidebar-resize-handle]");
		return h.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId: window.__lfPointerId }));
	})()`);
	await sleep(250);
	const after = JSON.parse(await page.evalJs(measureExpr()));
	await recoverDrag(page);
	return { dragging, dispatched, finished: !after.resizing, x };
}

/** 场景 C：拖动中窗口失焦（blur / visibilitychange）必须收尾 */
async function scenarioWindowBlur(page) {
	const { dragging } = await beginDragInside(page);
	await page.evalJs(`(() => { window.dispatchEvent(new Event("blur")); return true; })()`);
	await sleep(250);
	const after = JSON.parse(await page.evalJs(measureExpr()));
	await recoverDrag(page);
	return { dragging, finished: !after.resizing };
}

/** 场景 D：拖动中收到 `buttons === 0` 的 move（用户在外面松手后把鼠标移回来的形状）必须收尾 */
async function scenarioZeroButtonsMove(page) {
	const { dragging, x } = await beginDragInside(page);
	await dispatchMouse(page, "mouseMoved", x + 60, DRAG_Y, { buttons: 0 });
	await sleep(250);
	const after = JSON.parse(await page.evalJs(measureExpr()));
	await recoverDrag(page);
	return { dragging, finished: !after.resizing };
}

/* ---------------- V2：拖动期关过渡不跳帧 ---------------- */
async function v2Drag(page, { isProbe }) {
	console.log(`\n=== V2 拖动（${isProbe ? "探针把手（阶段 0 用法）" : "真实把手"}）===`);
	await page.evalJs(RESET_DRAG_STATE);
	await recoverDrag(page);
	await setUserWidth(page, SIDEBAR_DEFAULT_WIDTH, { isProbe });
	await sleep(700);
	const geom = JSON.parse(await page.evalJs(HANDLE_GEOM));
	console.log(`  把手命中区宽 ${geom.width}px，中心 x = ${geom.x}`);

	/* ---- 量测通道（不截图：截图会打断进行中的指针捕获，见文件头说明） ---- */

	// 常态 / hover 两态的分界发丝线样式（hover 建立不起来时记 SKIP，不误报）
	await dispatchMouse(page, "mouseMoved", 900, DRAG_Y + 120);
	await sleep(200);
	const lineIdle = JSON.parse(await page.evalJs(LINE_STYLE));
	await dispatchMouse(page, "mouseMoved", 5, DRAG_Y - 60);
	await dispatchMouse(page, "mouseMoved", Math.max(1, Math.round(geom.x)), DRAG_Y);
	await sleep(250);
	const hoverOn = await page.evalJs(`!!document.querySelector(".sidebar-resize-handle:hover")`);
	const lineHover = JSON.parse(await page.evalJs(LINE_STYLE));
	if (!hoverOn) {
		skip(
			"V2-h 把手可见反馈（hover）",
			"CDP 合成鼠标这次没建立 hover（合成事件 hover 已知不稳），视觉证据见 v2-handle-hover.png",
		);
	} else {
		check(
			"V2-h 把手可见反馈：hover 让同一条发丝线加重（没新增第二条竖线）",
			lineIdle.background !== lineHover.background &&
				lineIdle.width === lineHover.width &&
				lineIdle.display !== "none",
			`线宽两态一致（${lineIdle.width}）；背景${lineIdle.background !== lineHover.background ? "已加重" : "未变"}`,
		);
	}

	// ① 关过渡（真实实现固定如此；探针用 disableTransition 模拟）
	let lineDrag = null;
	if (isProbe) await page.evalJs(`(() => { window.__lfProbe.disableTransition = true; return true; })()`);
	const off = await dragBy(page, 200, {
		steps: 10,
		between: async (i) => {
			if (i === 6) lineDrag = JSON.parse(await page.evalJs(LINE_STYLE));
		},
	});
	const clampedTarget = (step) =>
		Math.min(
			Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, SIDEBAR_DEFAULT_WIDTH + step)),
			Math.min(SIDEBAR_MAX_WIDTH, off.settled.parentWidth - CHAT_MIN_WIDTH),
		);
	const offLag = Math.max(...off.samples.map((s) => Math.abs(s.measured - clampedTarget(s.step))));
	check(
		"V2-a 拖动中宽度与指针同步（滞后 ≤ 8px）",
		offLag <= 8,
		`最大滞后 ${offLag.toFixed(1)}px（${off.samples.length} 步 × 20px）`,
	);
	check(
		"V2-b 松手后无追赶动画（宽度不再变化）",
		Math.abs(off.settled.sidebarWidth - off.atRelease.sidebarWidth) < 2,
		`松手 ${off.atRelease.sidebarWidth}px → 500ms 后 ${off.settled.sidebarWidth}px`,
	);
	check(
		"V2-c 松手后过渡已恢复（is-resizing 摘掉）",
		!off.settled.resizing &&
			(await page.evalJs(`getComputedStyle(document.querySelector(".sidebar")).transitionDuration !== "0s"`)),
		"transitionDuration 非 0s",
	);
	check(
		"V2-d 拖动中 body 光标已还原（pointerup / pointercancel 路径都收尾）",
		(await page.evalJs("document.body.style.cursor")) === "",
		"松手后 body cursor 为空",
	);
	check(
		"V2-e 拖动中内层仍与外层同宽（R1 回归）",
		off.samples.every((s) => s.measured > 0) && off.settled.innerOverflowPx === 0,
		`松手后溢出 ${off.settled.innerOverflowPx}px`,
	);
	if (lineDrag && lineDrag.background !== lineHover.background) {
		check(
			"V2-i 拖动中把手再深一档（拖动色没被 hover 规则盖掉）",
			true,
			`hover → 拖动：背景已加深（${lineIdle.width} 线不变）`,
		);
	} else {
		skip(
			"V2-i 拖动色",
			`拖动中取到的线样式与 hover 相同（lineDrag = ${JSON.stringify(lineDrag?.background ?? null)}）`,
		);
	}

	// ② 对照组：不关过渡（只有探针模式可构造）—— 用来证明决策必要
	if (isProbe) {
		await page.evalJs(`(() => { window.__lfProbe.setUserWidth(${SIDEBAR_DEFAULT_WIDTH}); return true; })()`);
		await sleep(700);
		await page.evalJs(`(() => { window.__lfProbe.disableTransition = false; return true; })()`);
		const on = await dragBy(page, 200, { steps: 10 });
		const onLag = Math.max(...on.samples.map((s) => Math.abs(s.measured - clampedTarget(s.step))));
		console.log(
			`  对照组（**不关**过渡）：最大滞后 ${onLag.toFixed(1)}px，` +
				`松手 2 帧内 ${on.atRelease.sidebarWidth}px、500ms 后 ${on.settled.sidebarWidth}px`,
		);
		check(
			"V2-f 对照组证实「关过渡」确有必要（不关时滞后明显更大）",
			onLag > offLag + 5,
			`关过渡 ${offLag.toFixed(1)}px vs 不关 ${onLag.toFixed(1)}px`,
		);
		await page.evalJs(`(() => { window.__lfProbe.disableTransition = true; return true; })()`);
	} else {
		skip("V2-f 对照组", "真实把手固定关过渡，对照组只能由探针构造（阶段 0 已测）");
	}

	// ③ 复位
	await page.evalJs(RESET_DRAG_STATE);
	await setUserWidth(page, SIDEBAR_DEFAULT_WIDTH, { isProbe });
	await sleep(700);
	const back = JSON.parse(await page.evalJs(measureExpr()));
	check(
		"V2-g 复位：设回 240 后宽度跟随",
		Math.abs(back.sidebarWidth - SIDEBAR_DEFAULT_WIDTH) < 1,
		`实测 ${back.sidebarWidth}px`,
	);

	// ④ 两端极限：拖过头要停住（不越界、不飘）
	await dragBy(page, -320, { steps: 5 });
	await sleep(650);
	const minSide = JSON.parse(await page.evalJs(measureExpr()));
	check(
		"V2-j 左拖到头停在最小宽 200px",
		Math.abs(minSide.sidebarWidth - SIDEBAR_MIN_WIDTH) < 1,
		`实测 ${minSide.sidebarWidth}px`,
	);
	// 从小宽拖到最大：指针不能出视口，所以分两段（每段重新取把手坐标）
	for (const delta of [300, 300]) {
		await dragBy(page, delta, { steps: 5 });
		await sleep(500);
	}
	const maxSide = JSON.parse(await page.evalJs(measureExpr()));
	check(
		"V2-k 右拖到头停在最大宽 480px",
		Math.abs(maxSide.sidebarWidth - SIDEBAR_MAX_WIDTH) < 1,
		`实测 ${maxSide.sidebarWidth}px`,
	);

	// ⑤ 落盘（手测 1 的「松手读 ui-state.json 有值」）
	await sleep(300);
	let persisted = null;
	try {
		persisted = JSON.parse(readFileSync(DEV_UI_STATE, "utf8"));
	} catch (error) {
		console.log(`  （读 dev ui-state.json 失败：${error.message}）`);
	}
	check(
		"V2-l 松手后 dev ui-state.json 里的 sidebarWidth = 拖动结果",
		persisted?.sidebarWidth === SIDEBAR_MAX_WIDTH,
		`文件值 = ${JSON.stringify(persisted?.sidebarWidth)}`,
	);

	/* ---- 收尾兜底（X3，2026-10-07）：只有 pointerup/pointercancel 时会永久卡在拖动态 ---- */
	const lostUp = await scenarioLostPointerUp(page);
	check(
		"V2-q【X3】松手事件丢失后能自愈（鼠标移回窗口即收尾，之后还能正常拖）",
		lostUp.stuckBefore && lostUp.healed && lostUp.canDragAfter,
		`丢失后卡住=${lostUp.stuckBefore}（预期 true，这一步本来就没有任何信号）→ 移回后自愈=${lostUp.healed} → 再拖=${lostUp.canDragAfter}；宽度 ${lostUp.widths}`,
	);
	const lostCapture = await scenarioLostPointerCapture(page);
	check(
		"V2-r【X3】指针捕获丢失即刻收尾（lostpointercapture 兜底）",
		lostCapture.dragging && lostCapture.dispatched && lostCapture.finished,
		`拖动中=${lostCapture.dragging} 派发 lostpointercapture=${lostCapture.dispatched} → 收尾=${lostCapture.finished}（Chromium 里脚本调 releasePointerCapture 不触发该事件，故用合成事件测接线）`,
	);
	const blurred = await scenarioWindowBlur(page);
	check(
		"V2-s【X3】窗口失焦即刻收尾（blur / visibilitychange 兜底）",
		blurred.dragging && blurred.finished,
		`拖动中=${blurred.dragging} → blur 后收尾=${blurred.finished}`,
	);
	const zeroButtons = await scenarioZeroButtonsMove(page);
	check(
		"V2-t【X3】拖动中收到 buttons=0 的 move 即刻收尾（窗外松手后把鼠标移回来的形状）",
		zeroButtons.dragging && zeroButtons.finished,
		`拖动中=${zeroButtons.dragging} → buttons=0 的 move 后收尾=${zeroButtons.finished}`,
	);

	/* ---- 命中层（X2，2026-10-07）：侧栏越宽越容易被聊天列里溢出的透明块吃掉右缘 ---- */
	for (const width of [SIDEBAR_DEFAULT_WIDTH, 360, SIDEBAR_MAX_WIDTH]) {
		await setUserWidth(page, width, { isProbe });
		await sleep(700);
		const hit = JSON.parse(await page.evalJs(HIT_STACK));
		check(`V2-n 侧栏 ${width}px：把手中心最上层就是把手自己`, hit.topIsHandle, `最上层 = ${hit.topAtHandle}`);
		check(
			`V2-o 侧栏 ${width}px：栏内可见控件无一点击死区`,
			hit.visibleScanned > 0 && hit.blocked.length === 0,
			hit.blocked.length
				? `被栏外元素盖住：${JSON.stringify(hit.blocked.slice(0, 6))}${hit.blocked.length > 6 ? ` …共 ${hit.blocked.length} 个` : ""}`
				: `测了 $hit.visibleScanned/${hit.scannedControls} 个可见控件（已排除被祖先裁掉的），无栏外遮挡`,
		);
	}

	// 松手后**重新抓**（X2 的核心复现路径）：拖动中指针被 capture 锁定不做命中测试，只有重抓才暴露遮挡
	await setUserWidth(page, SIDEBAR_MAX_WIDTH, { isProbe });
	await sleep(700);
	const regrab = await dragBy(page, -120, { steps: 4 });
	const regrabWidth = regrab.settled.sidebarWidth;
	check(
		"V2-p 拖到 480 松手后仍能重新抓住把手拖回来（X2 回归）",
		Math.abs(regrabWidth - (SIDEBAR_MAX_WIDTH - 120)) < 8,
		`重抓左拖 120px 后 = ${regrabWidth}px（期望 ≈ ${SIDEBAR_MAX_WIDTH - 120}）`,
	);

	/* ---- 截图通道（放在最后：截图会打断进行中的指针捕获，量测已经做完，卡住也不影响断言） ---- */
	await setUserWidth(page, SIDEBAR_DEFAULT_WIDTH, { isProbe });
	await sleep(700);
	const shotGeom = JSON.parse(await page.evalJs(HANDLE_GEOM));
	const clip = { x: shotGeom.sidebarRight - 48, y: 120, width: 96, height: 360, scale: 2 };
	await dispatchMouse(page, "mouseMoved", 900, DRAG_Y + 120);
	await sleep(250);
	await shot(page, "v2-handle-idle", clip);
	await forceHandleHover(page, true);
	const lineForcedHover = JSON.parse(await page.evalJs(LINE_STYLE));
	await shot(page, "v2-handle-hover", clip);
	await forceHandleHover(page, false);
	check(
		"V2-n hover 态截图（强制伪类钉住 hover）",
		lineForcedHover.background !== lineIdle.background,
		`截图用 CSS.forcePseudoState 钉 hover；同一条线背景${lineForcedHover.background !== lineIdle.background ? "已加重" : "未变"}`,
	);
	await dragBy(page, 120, {
		steps: 6,
		between: async (i) => {
			if (i === 3) {
				const g = await handleCenter(page);
				await shot(page, "v2-handle-dragging", { ...clip, x: g.sidebarRight - 48 });
			}
		},
	});
	const stuckAfterShot = await recoverDrag(page);
	check(
		"V2-m 拖动中截图之后拖动态能收尾（截图会打断指针捕获：靠回把手补一次 release 复原）",
		!stuckAfterShot,
		(await page.evalJs(`document.body.style.cursor`)) === "" ? "光标与 is-resizing 都已复位" : "仍残留拖动态",
	);

	// 收尾：回到默认宽
	await page.evalJs(RESET_DRAG_STATE);
	await setUserWidth(page, SIDEBAR_DEFAULT_WIDTH, { isProbe });
	await sleep(650);
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

/* ---------------- V4：窗口 bounds 生命周期（会主动退出 dev，务必放最后） ---------------- */

const FRAME_SAMPLER = (frames) => `(async () => {
	const deltas = [];
	let prev = performance.now();
	await new Promise((resolve) => {
		let n = 0;
		const tick = () => {
			const now = performance.now();
			deltas.push(now - prev);
			prev = now;
			if (++n >= ${frames}) return resolve();
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	deltas.shift();
	const sum = deltas.reduce((a, b) => a + b, 0);
	return JSON.stringify({
		frames: deltas.length,
		avg: Number((sum / deltas.length).toFixed(2)),
		max: Number(Math.max(...deltas).toFixed(2)),
		over25ms: deltas.filter((d) => d > 25).length,
	});
})()`;

const MAIN_SET_WIDTH = (width) =>
	`(() => {
	const { BrowserWindow } = process.mainModule.require("electron");
	const win = BrowserWindow.getAllWindows()[0];
	win.setBounds({ ...win.getNormalBounds(), width: ${width} });
	return true;
})()`;

/** 读 ui-state.json（带容错） */
function readUiState() {
	try {
		return JSON.parse(readFileSync(DEV_UI_STATE, "utf8"));
	} catch {
		return null;
	}
}

/**
 * 盯住 ui-state.json 的写入次数：JsonStore 是「写临时文件 + rename」，所以目标文件的
 * 每个 rename 事件 = 一次真实落盘（tmp 文件名的事件被过滤掉）。
 */
function watchUiStateWrites() {
	const events = [];
	const stateDir = dirname(DEV_UI_STATE);
	const watcher = watch(stateDir, (_type, filename) => {
		if (filename === "ui-state.json") events.push(Date.now());
	});
	return { events, close: () => watcher.close() };
}

async function v4Window() {
	console.log("\n=== V4 窗口 bounds 生命周期（结尾会主动退出 dev）===");
	let main;
	try {
		main = await connect(MAIN_PORT, (t) => t.webSocketDebuggerUrl);
		await main.send("Runtime.enable");
	} catch (error) {
		skip("V4 主进程探针", `${error.message}（dev 未带 --inspect=${MAIN_PORT}？）`);
		return;
	}

	// ① 防抖：连续 20 次改 bounds（25ms 一次）只能落盘很少次
	const watcher = watchUiStateWrites();
	await main.evalJs(`(async () => {
		const { BrowserWindow } = process.mainModule.require("electron");
		const win = BrowserWindow.getAllWindows()[0];
		for (let i = 0; i < 20; i++) {
			win.setBounds({ x: 200 + i, y: 60, width: 900 + i * 2, height: 620 });
			await new Promise((r) => setTimeout(r, 25));
		}
		return true;
	})()`);
	await sleep(BOUNDS_SAVE_DEBOUNCE_MS + 900);
	const burstWrites = watcher.events.length;
	check(
		"V4-a 连续 20 次窗口变化只落盘极少次（防抖生效）",
		burstWrites >= 1 && burstWrites <= 3,
		`${burstWrites} 次写入（20 次变化 / 防抖 ${BOUNDS_SAVE_DEBOUNCE_MS}ms；不防抖会是 20 次）`,
	);
	const afterBurst = readUiState();
	check(
		"V4-b 防抖后落盘的是**最后一次** bounds",
		afterBurst?.windowBounds?.width === 900 + 19 * 2,
		`文件值 = ${JSON.stringify(afterBurst?.windowBounds)}（期望宽 ${900 + 19 * 2}）`,
	);

	// ② 最大化不污染：文件里必须还是 normal 尺寸（getBounds 会给最大化尺寸）
	const beforeMax = readUiState()?.windowBounds;
	const maxState = JSON.parse(
		await main.evalJs(`(async () => {
			const { BrowserWindow } = process.mainModule.require("electron");
			const win = BrowserWindow.getAllWindows()[0];
			win.maximize();
			await new Promise((r) => setTimeout(r, 900));
			return JSON.stringify({ bounds: win.getBounds(), normal: win.getNormalBounds(), maximized: win.isMaximized() });
		})()`),
	);
	await sleep(BOUNDS_SAVE_DEBOUNCE_MS + 400);
	const afterMax = readUiState()?.windowBounds;
	check(
		"V4-c 最大化时 getBounds ≠ getNormalBounds（测试本身非空转）",
		maxState.maximized && JSON.stringify(maxState.bounds) !== JSON.stringify(maxState.normal),
		`getBounds ${JSON.stringify(maxState.bounds)} vs normal ${JSON.stringify(maxState.normal)}`,
	);
	check(
		"V4-d【关键】最大化**不污染**落盘 bounds（写的必须是 normal 态）",
		afterMax?.width === beforeMax?.width && afterMax?.height === beforeMax?.height,
		`最大化前后文件值：${JSON.stringify(beforeMax)} → ${JSON.stringify(afterMax)}`,
	);

	// ③ 最小化同样不污染
	await main.evalJs(`(async () => {
		const { BrowserWindow } = process.mainModule.require("electron");
		const win = BrowserWindow.getAllWindows()[0];
		win.unmaximize();
		await new Promise((r) => setTimeout(r, 600));
		win.minimize();
		await new Promise((r) => setTimeout(r, 700));
		win.restore();
		await new Promise((r) => setTimeout(r, 400));
		return true;
	})()`);
	await sleep(BOUNDS_SAVE_DEBOUNCE_MS + 400);
	const restored = JSON.parse(
		await main.evalJs(`(() => {
			const { BrowserWindow } = process.mainModule.require("electron");
			return JSON.stringify(BrowserWindow.getAllWindows()[0].getNormalBounds());
		})()`),
	);
	check(
		"V4-e 最小化/还原不污染落盘 bounds",
		JSON.stringify(restored) === JSON.stringify(afterMax),
		`还原后 normal = ${JSON.stringify(restored)}，文件值 = ${JSON.stringify(readUiState()?.windowBounds)}`,
	);

	// ④ 退出兜底：防抖窗口内直接退出，靠 close 里的同步写兜住
	watcher.events.length = 0;
	const quitTarget = { x: 222, y: 66, width: 940, height: 660 };
	await main.evalJs(`(() => {
		const { BrowserWindow } = process.mainModule.require("electron");
		const win = BrowserWindow.getAllWindows()[0];
		win.setBounds({ x: ${quitTarget.x}, y: ${quitTarget.y}, width: ${quitTarget.width}, height: ${quitTarget.height} });
		return true;
	})()`);
	await sleep(80); // 远小于防抖 400ms：这时异步写还没发生
	const beforeQuit = readUiState()?.windowBounds ?? null;
	console.log(`  退出前文件值 = ${JSON.stringify(beforeQuit)}（应还没写出新 bounds）`);
	// 触发优雅退出：before-quit → close（我们在这里同步 flush）
	main
		.evalJs(`(() => { process.mainModule.require("electron").app.quit(); return true; })()`)
		.catch(() => {});
	await sleep(3500);
	const afterQuit = readUiState()?.windowBounds ?? null;
	watcher.close();
	check(
		"V4-f【关键】退出兜底：防抖未到就退出，close 里同步写保住最后一次 bounds",
		afterQuit?.width === quitTarget.width && afterQuit?.height === quitTarget.height,
		`退出后文件值 = ${JSON.stringify(afterQuit)}（期望 ${JSON.stringify(quitTarget)}）`,
	);
	// 主进程退出前会等 inspector 断开，所以先放开连接再轮询端口
	main.close();
	let exited = false;
	for (let i = 0; i < 16; i++) {
		try {
			execSync(`lsof -ti:${PAGE_PORT}`, { stdio: "pipe" });
		} catch {
			exited = true;
			break;
		}
		await sleep(500);
	}
	console.log(`  dev 主进程：${exited ? "已退出" : "仍在运行"} —— 跑其它子命令前先重启 dev`);
}

/* ---------------- V5：R5 观察项 —— 连续缩放窗口时的帧间隔 ---------------- */

async function v5Frames(page, { isProbe }) {
	console.log("\n=== V5 连续缩放窗口的帧间隔（R5 观察项，只报数不判定）===");
	let main;
	try {
		main = await connect(MAIN_PORT, (t) => t.webSocketDebuggerUrl);
		await main.send("Runtime.enable");
	} catch (error) {
		skip("V5 主进程探针", `${error.message}（dev 未带 --inspect=${MAIN_PORT}？）`);
		return;
	}
	await page.evalJs(RESIZE_WINDOW(WIDE_WINDOW.width, WIDE_WINDOW.height));
	await sleep(600);

	const runCase = async (label, userWidth, windowWidths) => {
		await setUserWidth(page, userWidth, { isProbe });
		await sleep(700);
		await page.evalJs(RESIZE_WINDOW(windowWidths[0], 750));
		await sleep(700);
		const framesPromise = page.send("Runtime.evaluate", {
			expression: FRAME_SAMPLER(120),
			returnByValue: true,
			awaitPromise: true,
		});
		for (let i = 0; i < 60; i++) {
			await main.evalJs(MAIN_SET_WIDTH(windowWidths[i % windowWidths.length]));
			await sleep(25);
		}
		const { result } = await framesPromise;
		const stats = JSON.parse(result.value);
		const renders = JSON.parse(
			await page.evalJs(`(() => {
				const sb = document.querySelector(".sidebar");
				return JSON.stringify({ render: parseFloat(getComputedStyle(sb).width), userVar: sb.style.getPropertyValue("--sidebar-render-width") });
			})()`),
		);
		console.log(
			`  ${label}：帧 ${stats.frames} / 平均 ${stats.avg}ms / 最大 ${stats.max}ms / >25ms ${stats.over25ms} 帧（末帧侧栏 ${renders.render}px）`,
		);
		return stats;
	};

	const jitter = [700, 768];
	const changing = await runCase(
		"A 用户值 480 + 窗口 700↔768（渲染宽每帧变 → Sidebar 每帧重渲染）",
		480,
		jitter,
	);
	const constant = await runCase("B 用户值 240 + 同一窗口抖动（渲染宽恒 240 → 不重渲染）", 240, jitter);
	record(
		"A/B 帧间隔对比（R5：宽窗不够时 renderWidth 每帧变是否拖慢渲染）",
		null,
		`A 平均 ${changing.avg}ms / >25ms ${changing.over25ms} 帧；B 平均 ${constant.avg}ms / >25ms ${constant.over25ms} 帧`,
	);
	await page.evalJs(RESIZE_WINDOW(WIDE_WINDOW.width, WIDE_WINDOW.height));
	await main.evalJs(MAIN_SET_WIDTH(WIDE_WINDOW.width));
	await sleep(500);
	main.close();
}

/* ---------------- #100：真实列表 + 整段命中回归 ---------------- */
async function v6Handle(page) {
	const expectBug = process.argv.includes("--expect-handle-bug");
	try {
		await page.evalJs(`(async () => {
		const { useProjectsStore: projects } = await import('/src/stores/projects.ts');
		const { useUiPreferencesStore: prefs } = await import('/src/stores/ui-preferences.ts');
		const p = projects.getState(), u = prefs.getState();
		window.__handleRegression = {
			projects, prefs,
			projectState: { allSessions: p.allSessions, addedProjects: p.addedProjects, search: p.search },
			prefState: { sidebarCollapsed: u.sidebarCollapsed, sidebarWidth: u.sidebarWidth,
				expandedGroups: u.expandedGroups, expandedGroupsTouched: u.expandedGroupsTouched },
			width: outerWidth, height: outerHeight, x: screenX, y: screenY,
			z: null, priority: '',
			scrollTop: document.querySelector('[data-sidebar-scroll-root]').scrollTop
		};
		prefs.setState({ sidebarCollapsed: false });
		window.resizeTo(1100, 750);
	})()`);
		await sleep(550);
		const real = await page.evalJs(`(() => {
			const handles = [...document.querySelectorAll('[data-sidebar-resize-handle]')];
			return handles.length === 1 && handles[0].matches('hr.sidebar-resize-handle') &&
				handles[0].dataset.sidebarResizeHandle === '' &&
				!document.querySelector('#lf-probe-css') && !document.querySelector('[data-sidebar-resize-handle="probe"]');
		})()`);
		if (!real)
			throw Object.assign(new Error("环境不满足：V6 要求唯一真实把手、零 probe、零候选 CSS"), {
				exitCode: 2,
			});
		await page.evalJs(`(() => {
			const f = window.__handleRegression, h = document.querySelector('[data-sidebar-resize-handle]');
			f.z = h.style.getPropertyValue('z-index'); f.priority = h.style.getPropertyPriority('z-index');
		})()`);
		console.log("V6 环境确认：唯一真实把手、零 probe、零候选 CSS");
		for (const width of [200, 240, 480]) {
			for (const scenario of ["none", "bottom", "both", "top"]) {
				await page.evalJs(`(() => {
					const f = window.__handleRegression;
					const sessions = ${scenario === "none" ? 0 : 24};
					const rows = Array.from({length: sessions}, (_, i) => ({
						sessionId: 'handle-fixture-' + i, cwd: '/handle-fixture/project-' + i,
						name: 'Handle regression ' + i, active: false, messageCount: 1,
						createdAt: 1000 + i, modifiedAt: 1000 + i
					}));
					f.projects.setState({allSessions: rows, addedProjects: [], search: ''});
					f.prefs.setState({sidebarWidth: ${width}, expandedGroups: rows.map(r => r.cwd), expandedGroupsTouched: true});
				})()`);
				await sleep(550); // 宽度/分组过渡结束后让真实 observer 更新 fade
				await page.evalJs(`(() => {
					const root = document.querySelector('[data-sidebar-scroll-root]');
					root.scrollTop = ${scenario === "top" ? "root.scrollHeight" : scenario === "both" ? "(root.scrollHeight-root.clientHeight)/2" : "0"};
				})()`);
				await page.evalJs(SETTLE);
				const scan = () =>
					page.evalJs(`(() => {
					const handle = document.querySelector('[data-sidebar-resize-handle]');
					const root = document.querySelector('[data-sidebar-scroll-root]');
					const h = handle.getBoundingClientRect(), r = root.getBoundingClientRect();
					const points = [h.top + 20, ...Array.from({length: 11}, (_, i) => r.top + 20 + (r.height-40)*i/10), h.bottom-20];
					return {
						width: h.width, sidebarWidth: handle.parentElement.getBoundingClientRect().width,
						top: root.dataset.fadeTop === 'true', bottom: root.dataset.fadeBottom === 'true',
						mask: getComputedStyle(root).maskImage, position: getComputedStyle(root).position,
						rows: root.querySelectorAll('[data-session-id]').length,
						overflow: root.scrollHeight > root.clientHeight,
						hits: points.map(y => { const el = document.elementFromPoint(h.right-4, y); return {
							y, list: y > r.top && y < r.bottom, hit: el === handle,
							stack: document.elementsFromPoint(h.right-4,y).slice(0,4).map(e => e.tagName+'.'+e.className)
						}; })
					};
				})()`);
				const original = await scan();
				const label = `V6 ${width}px fade=${scenario}`;
				check(
					`${label} 夹具有效`,
					original.top === ["both", "top"].includes(scenario) &&
						original.bottom === ["both", "bottom"].includes(scenario) &&
						original.width === 8 &&
						Math.abs(original.sidebarWidth - width) < 1 &&
						(scenario === "none"
							? !original.overflow
							: original.overflow && original.rows === 24 && original.mask !== "none"),
					JSON.stringify(original),
				);
				check(
					`${label} 原始命中`,
					original.hits.every((p) => p.hit === !(expectBug && scenario !== "none" && p.list)),
					JSON.stringify(original.hits),
				);
				await page.evalJs(
					`document.querySelector('[data-sidebar-resize-handle]').style.setProperty('z-index','1')`,
				);
				const fixed = await scan();
				check(
					`${label} z-index:1 整段命中`,
					fixed.hits.every((p) => p.hit),
					JSON.stringify(fixed.hits),
				);
				await page.evalJs(`(() => {
					const f = window.__handleRegression, h = document.querySelector('[data-sidebar-resize-handle]');
					f.z ? h.style.setProperty('z-index', f.z, f.priority) : h.style.removeProperty('z-index');
				})()`);
			}
		}
	} finally {
		await page.evalJs(`(() => {
			const f = window.__handleRegression;
			if (!f) return;
			const h = document.querySelector('[data-sidebar-resize-handle]');
			if (h && f.z !== null) f.z ? h.style.setProperty('z-index', f.z, f.priority) : h.style.removeProperty('z-index');
			f.projects.setState(f.projectState); f.prefs.setState(f.prefState);
			window.resizeTo(f.width, f.height);
		})()`);
		await sleep(550);
		const restored = await page.evalJs(`(() => {
			const f = window.__handleRegression;
			if (!f) return {ok: true, snapshotAbsent: true};
			const root = document.querySelector('[data-sidebar-scroll-root]');
			root.scrollTop = f.scrollTop;
			const h = document.querySelector('[data-sidebar-resize-handle]');
			const store = Object.entries(f.projectState).every(([k,v]) => f.projects.getState()[k] === v) &&
				Object.entries(f.prefState).every(([k,v]) => f.prefs.getState()[k] === v);
			const style = f.prefState.sidebarCollapsed ? !h : !!h && (f.z === null ||
				(h.style.getPropertyValue('z-index') === f.z && h.style.getPropertyPriority('z-index') === f.priority));
			const bounds = {width: outerWidth, height: outerHeight, x: screenX, y: screenY};
			const ok = store && style && outerWidth === f.width && outerHeight === f.height &&
				root.scrollTop === f.scrollTop &&
				!document.querySelector('[data-session-id^="handle-fixture-"]') &&
				!document.querySelector('[data-sidebar-resize-handle="probe"], #lf-probe-css');
			delete window.__handleRegression;
			return {ok, store, style, collapsed: f.prefState.sidebarCollapsed, bounds,
				originalBounds: {width: f.width, height: f.height, x: f.x, y: f.y}};
		})()`);
		console.log(`V6 恢复核对：${JSON.stringify(restored)}`);
		if (!restored.ok) check("V6 清理恢复核对", false, JSON.stringify(restored));
	}
}

/* ---------------- 主流程 ---------------- */
const mode = process.argv[2] ?? "all";
const page = await connect(PAGE_PORT, (t) => t.type === "page" && t.webSocketDebuggerUrl);
await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
await page.send("DOM.enable");
await page.send("CSS.enable");
for (let attempt = 0; !(await page.evalJs(`!!document.querySelector('.sidebar')`)); attempt++) {
	if (attempt >= 100) {
		page.close();
		console.error("环境不满足：20 秒内侧栏未挂载");
		process.exit(2);
	}
	await sleep(200);
}

const followsVar = await page.evalJs(DETECT_REAL_CSS);
const injectedCss = mode !== "v6-handle" && !followsVar;
if (mode === "v6-handle" && !followsVar) {
	page.close();
	console.error("环境不满足：V6 要求真实宽度 CSS，不允许降级");
	process.exit(2);
}
if (injectedCss) await page.evalJs(INJECT_CSS);
const handleKind = mode === "v6-handle" ? "real" : await page.evalJs(INSTALL_PROBE_HANDLE);
const isProbe = handleKind === "probe";
console.log(
	`环境：宽度变量 ${injectedCss ? "未落地 → 注入候选 CSS" : "已落地"}；把手 ${isProbe ? "未落地 → 注入探针" : "真实"}`,
);

try {
	if (mode === "v1-css" || mode === "all") await v1Css(page, { isProbe });
	if (mode === "v2-drag" || mode === "all") await v2Drag(page, { isProbe });
	if (mode === "v3-bounds" || mode === "all") await v3Bounds(page);
	if (mode === "v5-frames") await v5Frames(page, { isProbe });
	if (mode === "v6-handle") await v6Handle(page);
	if (mode === "v4-window") await v4Window();
} catch (error) {
	if (error.exitCode !== 2) throw error;
	console.error(error.message);
	process.exitCode = 2;
} finally {
	// v4 会主动退出 dev（页面连接已断），给收尾加超时，别让它把整轮结果卡住
	if (mode !== "v6-handle") {
		await Promise.race([page.evalJs(CLEANUP).catch(() => {}), sleep(1500)]);
	}
	page.close();
}

const fail = results.filter((r) => r.status === "FAIL");
const pass = results.filter((r) => r.status === "PASS");
const skipped = results.filter((r) => r.status === "SKIP");
console.log(
	`\n合计 ${results.length} 条：PASS ${pass.length} / FAIL ${fail.length} / SKIP ${skipped.length}` +
		(fail.length ? `\n失败项：\n${fail.map((f) => `  - ${f.name}：${f.detail}`).join("\n")}` : ""),
);
process.exit(process.exitCode ?? (fail.length ? 1 : 0));
