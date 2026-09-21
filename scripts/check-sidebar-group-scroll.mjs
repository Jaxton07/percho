/**
 * 左栏分组会话列表「限高 + 组内独立滚动」CDP 验收脚本（spec §7）
 *
 * 前置：dev 应用带调试端口运行
 *   cd packages/desktop && npx electron-vite dev -- --remote-debugging-port=9224
 *   （`npm run dev -- --remote-debugging-port=9224` 不行：npm 会把参数吞掉）
 *
 * 用法：node scripts/check-sidebar-group-scroll.mjs
 * 退出码：0 全部断言通过 / 1 有断言失败 / 2 环境不满足（无法判定，见提示）
 *
 * 纪律：
 * - 一律用 `data-sidebar-scroll-root` / `data-sidebar-session-list` / `[data-session-id]` 与
 *   **DOM 相邻关系**定位元素，不按中文/英文标题文案匹配（分组头与会话行文字会相同）；
 * - 滚动归属用 **CDP 真实 wheel**（`Input.dispatchMouseEvent` type=mouseWheel）验证，
 *   不用直接赋 scrollTop 冒充滚动（赋 scrollTop 只用于把容器预置到中部/边界）；
 * - 只读测量；结束时把外层与内层 scrollTop 复位为 0。
 *
 * 环境前提（不满足则退出码 2，而不是给假绿）：
 * - 左栏外层容器本身可滚（需要足够的项目/会话）；
 * - 至少有一个溢出列表（> 8 行）与一个不溢出列表（≤ 8 行）。
 *   当前 dev 数据（`~/.pi/agent-dev`）默认满足；若没有，用隔离的 dev agent dir 造临时会话即可。
 */
import { execSync } from "node:child_process";

const PORT = process.env.CDP_PORT ?? "9224";
/** 与 SidebarSessionList 的常量一致；改那边必须同步这里（验收口径） */
const MAX_ROWS = 8;
const ROW_HEIGHT = 31;
const PROJECT_ROW_HEIGHT = 34;
const LIST_MAX_HEIGHT = MAX_ROWS * ROW_HEIGHT;

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_ENV = 2;

/* ---------- CDP 连接 ---------- */
async function findPage(timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const list = JSON.parse(execSync(`curl -s http://127.0.0.1:${PORT}/json`).toString());
			const found = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
			if (found) return found;
		} catch {
			/* 端口未绑：下一轮 */
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	throw new Error(`等不到 page target（${PORT}）：dev 应用是否带 --remote-debugging-port=${PORT} 运行？`);
}

const page = await findPage().catch((err) => {
	console.error(`无法连接 CDP（退出码 ${EXIT_ENV}）：${err.message}`);
	process.exit(EXIT_ENV);
});
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
	if (result.exceptionDetails) throw new Error(`页面内执行失败：${JSON.stringify(result.exceptionDetails)}`);
	return result.result?.value;
}

// 窗口被遮挡时 rAF/合成器停摆：先把页面置为可见
await send("Emulation.setFocusEmulationEnabled", { enabled: true });

/* ---------- 断言记录 ---------- */
const results = [];
function check(name, ok, detail) {
	results.push({ name, ok: ok === true });
	console.log(`${ok ? "PASS" : "FAIL"} · ${name} · ${detail}`);
}
function note(text) {
	console.log(`     ${text}`);
}

/* ---------- 页面侧读取 ---------- */
const READ_SNAPSHOT = `(() => {
	const root = document.querySelector("[data-sidebar-scroll-root]");
	if (!root) return JSON.stringify({ error: "no-scroll-root" });
	const lists = [...root.querySelectorAll("[data-sidebar-session-list]")];
	return JSON.stringify({
		root: {
			clientH: root.clientHeight,
			scrollH: root.scrollHeight,
			clientW: root.clientWidth,
			scrollW: root.scrollWidth,
			top: root.scrollTop,
		},
		lists: lists.map((el, i) => {
			const cs = getComputedStyle(el);
			const rows = [...el.querySelectorAll("[data-session-id]")];
			// 分组标题行：用 DOM 相邻关系（分组根 div 里的 aria-expanded 按钮），不按文案匹配
			const title = el.parentElement ? el.parentElement.querySelector("button[aria-expanded]") : null;
			return {
				i,
				scrollable: el.dataset.scrollable === "true",
				maxHeight: cs.maxHeight,
				overflowY: cs.overflowY,
				overflowX: cs.overflowX,
				overscrollY: cs.overscrollBehaviorY,
				clientH: el.clientHeight,
				scrollH: el.scrollHeight,
				clientW: el.clientWidth,
				scrollW: el.scrollWidth,
				top: el.scrollTop,
				rowCount: rows.length,
				rowHeights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
				titleHeight: title ? Math.round(title.getBoundingClientRect().height) : null,
				titleInsideList: !!el.querySelector("button[aria-expanded]"),
			};
		}),
	});
})()`;

function snapshot() {
	return evalJs(READ_SNAPSHOT).then(JSON.parse);
}

/** 所有可滚容器（外层 + 各内层）的当前位置，用于判断某次手势影响了谁 */
function positions() {
	return evalJs(`(() => {
	const root = document.querySelector("[data-sidebar-scroll-root]");
	const lists = [...root.querySelectorAll("[data-sidebar-session-list]")];
	return JSON.stringify({ outer: root.scrollTop, lists: lists.map((l) => l.scrollTop) });
})()`).then(JSON.parse);
}

function reset() {
	return evalJs(`(() => {
	const root = document.querySelector("[data-sidebar-scroll-root]");
	root.scrollTop = 0;
	for (const l of root.querySelectorAll("[data-sidebar-session-list]")) l.scrollTop = 0;
	return true;
})()`);
}

/** 把某个内层预置到中部（用于「非边界位置」的手势；不是用它代替 wheel） */
function presetListTop(index, cssExpr) {
	return evalJs(`(() => {
	const l = document.querySelectorAll("[data-sidebar-session-list]")[${index}];
	l.scrollTop = ${cssExpr};
	return l.scrollTop;
})()`);
}

/** 目标中心点（必须落在外层容器可视区内，否则手势会落到别的元素上） */
async function centerOf(selectorExpr) {
	return JSON.parse(
		await evalJs(`(() => {
			const root = document.querySelector("[data-sidebar-scroll-root]");
			const el = ${selectorExpr};
			if (!el) return JSON.stringify(null);
			const a = root.getBoundingClientRect();
			const r = el.getBoundingClientRect();
			const top = Math.max(r.top, a.top);
			const bottom = Math.min(r.bottom, a.bottom);
			return JSON.stringify({
				cx: r.left + r.width / 2,
				cy: (top + bottom) / 2,
				visibleHeight: bottom - top,
			});
		})()`),
	);
}

/** 等滚动停止（平滑滚动/惯性都要落定后再读数） */
async function settle(timeoutMs = 900) {
	const deadline = Date.now() + timeoutMs;
	let prev = JSON.stringify(await positions());
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 90));
		const cur = JSON.stringify(await positions());
		if (cur === prev) return;
		prev = cur;
	}
}

/** 真实 wheel：指针先移到目标上（命中区决定滚动链），再派发 wheel */
async function wheel(selectorExpr, deltaY, times = 1) {
	const c = await centerOf(selectorExpr);
	if (!c || c.visibleHeight < 8) {
		throw new Error(`目标不可见，无法投递 wheel：${selectorExpr} → ${JSON.stringify(c)}`);
	}
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.cx, y: c.cy, button: "none" });
	for (let i = 0; i < times; i++) {
		await send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: c.cx,
			y: c.cy,
			deltaX: 0,
			deltaY,
			pointerType: "mouse",
		});
		await new Promise((r) => setTimeout(r, 70));
	}
	await settle();
}

const listExpr = (i) => `document.querySelectorAll("[data-sidebar-session-list]")[${i}]`;
const titleExpr = (i) =>
	`document.querySelectorAll("[data-sidebar-session-list]")[${i}].parentElement.querySelector("button[aria-expanded]")`;

/* ---------- 1. 结构与尺寸契约 ---------- */
console.log("=== 1. 结构与尺寸 ===");
const snap = await snapshot();
if (snap.error === "no-scroll-root") {
	console.error(
		`FAIL · 左栏没有 [data-sidebar-scroll-root]：Sidebar 的改动没进包/没生效（退出码 ${EXIT_ENV}）`,
	);
	ws.close();
	process.exit(EXIT_ENV);
}
await reset();
const lists = snap.lists;
note(
	`外层容器 clientH=${snap.root.clientH} scrollH=${snap.root.scrollH}；展开的组（有列表容器的）= ${lists.length} 个`,
);
check(
	"外层滚动容器存在且自身可滚（环境前提）",
	snap.root.scrollH > snap.root.clientH,
	`clientH ${snap.root.clientH} / scrollH ${snap.root.scrollH}`,
);
check(
	"外层无横向滚动",
	snap.root.scrollW === snap.root.clientW,
	`scrollW ${snap.root.scrollW} / clientW ${snap.root.clientW}`,
);

for (const l of lists) {
	const label = `列表#${l.i}（${l.rowCount} 行）`;
	check(
		`${label} 上限 248px、纵向可滚、横向隐藏`,
		l.maxHeight === `${LIST_MAX_HEIGHT}px` && l.overflowY === "auto" && l.overflowX === "hidden",
		`maxHeight ${l.maxHeight} / overflowY ${l.overflowY} / overflowX ${l.overflowX}`,
	);
	check(
		`${label} 无横向溢出（滚动条不造成宽度跳变）`,
		l.scrollW === l.clientW,
		`scrollW ${l.scrollW} / clientW ${l.clientW}`,
	);
	check(
		`${label} 会话行仍为 31px`,
		l.rowHeights.length > 0 && l.rowHeights.every((h) => h === ROW_HEIGHT),
		`行高 ${[...new Set(l.rowHeights)].join("/") || "无行"}`,
	);
	check(
		`${label} 项目/日常标题行 34px 且在滚动容器之外`,
		l.titleInsideList === false && l.titleHeight === PROJECT_ROW_HEIGHT,
		`标题行 ${l.titleHeight}px / 在列表容器内=${l.titleInsideList}`,
	);
	check(
		`${label} contain 与 data-scrollable 同源（${l.scrollable ? "溢出挂 contain" : "不溢出留 auto"}）`,
		l.scrollable ? l.overscrollY === "contain" : l.overscrollY === "auto",
		`data-scrollable=${l.scrollable} / overscroll-behavior-y=${l.overscrollY}`,
	);
	if (l.scrollable) {
		check(
			`${label} clientHeight=248 且 scrollHeight>clientHeight`,
			l.clientH === LIST_MAX_HEIGHT && l.scrollH > l.clientH,
			`clientH ${l.clientH} / scrollH ${l.scrollH}`,
		);
	} else {
		check(
			`${label} 无内部可滚范围（自然高度，不制造空白）`,
			l.scrollH === l.clientH,
			`clientH ${l.clientH} / scrollH ${l.scrollH}`,
		);
	}
}

/* ---------- 环境前提：溢出/不溢出两类列表都要有 ---------- */
const overflow = lists.filter((l) => l.scrollable);
const fit = lists.filter((l) => !l.scrollable);
if (overflow.length === 0 || fit.length === 0) {
	console.error(
		`FAIL · 环境不满足：需要至少一个 > ${MAX_ROWS} 行的组（现有 ${overflow.length} 个）与一个 ≤ ${MAX_ROWS} 行的组` +
			`（现有 ${fit.length} 个）。请在 dev agent dir（~/.pi/agent-dev/sessions）造临时会话后重跑（退出码 ${EXIT_ENV}）`,
	);
	ws.close();
	process.exit(EXIT_ENV);
}
note(
	`溢出列表 ${overflow.length} 个（#${overflow.map((l) => l.i).join("/")}）、不溢出列表 ${fit.length} 个（#${fit.map((l) => l.i).join("/")}）`,
);

/* ---------- 2. 真实 wheel：内层中部 / 内层边界 / 标题行 ---------- */
console.log("\n=== 2. 真实 wheel 的滚动归属 ===");
for (const l of overflow) {
	const label = `列表#${l.i}（${l.rowCount} 行）`;

	// a) 内层中部：只有内层动
	await reset();
	await presetListTop(l.i, "60");
	let before = await positions();
	await wheel(listExpr(l.i), 50);
	let after = await positions();
	check(
		`${label} 内层中部 wheel → 只滚内层`,
		after.lists[l.i] > before.lists[l.i] && after.outer === before.outer,
		`内层 ${before.lists[l.i]}→${after.lists[l.i]}（max ${l.scrollH - l.clientH}）/ 外层 ${before.outer}→${after.outer}`,
	);

	// b) 内层到底继续滚：不穿透
	await reset();
	await presetListTop(l.i, "99999");
	before = await positions();
	await wheel(listExpr(l.i), 120, 2);
	after = await positions();
	check(
		`${label} 内层到底继续 wheel → 外层不动（不穿透）`,
		after.lists[l.i] === before.lists[l.i] && after.outer === 0,
		`内层 ${before.lists[l.i]}→${after.lists[l.i]} / 外层 ${before.outer}→${after.outer}`,
	);

	// c) 内层到顶继续上滚：不穿透
	await reset();
	await evalJs(`document.querySelector("[data-sidebar-scroll-root]").scrollTop = 40`);
	await presetListTop(l.i, "0");
	before = await positions();
	await wheel(listExpr(l.i), -120, 2);
	after = await positions();
	check(
		`${label} 内层到顶继续上滚 → 外层不动（不穿透）`,
		after.lists[l.i] === 0 && after.outer === before.outer,
		`内层 ${before.lists[l.i]}→${after.lists[l.i]} / 外层 ${before.outer}→${after.outer}`,
	);

	// d) 组标题行（内层之外）：只滚外层
	await reset();
	before = await positions();
	await wheel(titleExpr(l.i), 60);
	after = await positions();
	check(
		`${label} 标题行 wheel → 只滚外层`,
		after.outer > before.outer && after.lists.every((t, i) => t === before.lists[i]),
		`外层 ${before.outer}→${after.outer} / 各内层 ${before.lists.join(",")}→${after.lists.join(",")}`,
	);
}

// e) 不溢出的列表：不挂 contain，滚轮自然交给外层
for (const l of fit) {
	await reset();
	const before = await positions();
	await wheel(listExpr(l.i), 60);
	const after = await positions();
	check(
		`列表#${l.i}（${l.rowCount} 行，不溢出）内 wheel → 交给外层`,
		after.outer > before.outer,
		`外层 ${before.outer}→${after.outer} / 内层 ${before.lists[l.i]}（max 0）`,
	);
}

/* ---------- 3. 收尾：复位 ---------- */
await reset();
const end = await positions();
check(
	"收尾：外层与各内层 scrollTop 已复位为 0",
	end.outer === 0 && end.lists.every((t) => t === 0),
	`外层 ${end.outer} / 内层 ${end.lists.join(",")}`,
);

ws.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
	console.log("失败项：");
	for (const f of failed) console.log(`  - ${f.name}`);
	process.exit(EXIT_FAIL);
}
process.exit(EXIT_OK);
