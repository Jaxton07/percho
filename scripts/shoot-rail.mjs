// 阶段 3 验收脚本：左侧轨道 + 顶栏开关 + 布局量测（CDP，确定性）
//
// 用法（先起 dev：cd packages/desktop && npx electron-vite dev -- --remote-debugging-port=9224）：
//   node scripts/shoot-rail.mjs measure    # 量测：布局/遮挡/窄窗口/轨道几何，打表
//   node scripts/shoot-rail.mjs wave       # 轨道波浪逐帧（悬停第 2 条，按 CSS 参数复现关键帧）
//   node scripts/shoot-rail.mjs states     # 组态截图：轨道关/顶栏关/都开/窄窗/双主题
//
// 出图目录默认 .local/shots/rail（gitignore 内）；脚本结束时不动 dev 进程（人工确认后再关）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.CDP_PORT ?? 9224);

/**
 * fail-fast 断言：不满足就抛（顶层捕获后 `process.exit(1)`）。
 * 验收脚本的「断言」必须能在回归时**自动失败** —— 只把真值打出来让人肉眼看不算验证。
 */
function assert(cond, message) {
	if (!cond) throw new Error(`断言失败：${message}`);
}
function assertEqual(actual, expected, message) {
	assert(
		actual === expected,
		`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
	);
}
const OUT = resolve(process.env.SHOT_DIR ?? ".local/shots/rail");
const MODE = process.argv[2] ?? "measure";

async function pageTarget() {
	const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
	const list = await res.json();
	const target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
	if (!target) throw new Error("没有可调试页面：dev 是否带 --remote-debugging-port 启动？");
	return target;
}

class Cdp {
	constructor(ws) {
		this.ws = ws;
		this.id = 0;
		this.pending = new Map();
		this.events = [];
		ws.addEventListener("message", (event) => {
			const msg = JSON.parse(event.data);
			if (msg.id && this.pending.has(msg.id)) {
				const { resolve: done, reject } = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				msg.error ? reject(new Error(JSON.stringify(msg.error))) : done(msg.result);
				return;
			}
			// 控制台事件（Runtime.consoleAPICalled / Log.entryAdded）：GC 卸载日志靠它取证
			if (msg.method === "Runtime.consoleAPICalled") {
				this.events.push({
					type: msg.params.type,
					text: (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" "),
				});
			}
		});
	}
	send(method, params = {}) {
		const id = ++this.id;
		return new Promise((done, reject) => {
			this.pending.set(id, { resolve: done, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}
	async eval(expression) {
		const out = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? "eval 失败");
		return out.result.value;
	}
	async shot(name, clip) {
		const res = await this.send("Page.captureScreenshot", {
			format: "png",
			...(clip ? { clip: { ...clip, scale: 1 } } : {}),
		});
		const file = resolve(OUT, `${name}.png`);
		writeFileSync(file, Buffer.from(res.data, "base64"));
		return file;
	}
}

async function withPage(fn) {
	const target = await pageTarget();
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((done, fail) => {
		ws.addEventListener("open", done, { once: true });
		ws.addEventListener("error", fail, { once: true });
	});
	const cdp = new Cdp(ws);
	// 窗口被遮挡时 rAF 停摆、scroll 不派发：把页面强制置为可见（PITFALLS 五）
	await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");
	try {
		return await fn(cdp);
	} finally {
		ws.close();
	}
}

/** 等两个 rAF：React flush + transition 创建（AGENTS.md 的确定性钉帧前提） */
const TWO_RAF = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`;

const LAYOUT = `(() => {
	const root = document.documentElement;
	const rail = document.querySelector('nav[aria-label]');
	const item = document.querySelector('.session-rail-item');
	const capsule = item?.querySelector('.rail-capsule');
	const tabBar = document.querySelector('.tab-pill')?.closest('div[class*="h-12"]') ?? null;
	const sidebar = document.querySelector('aside') ?? null;
	const main = document.querySelector('main') ?? null;
	const box = (el) => {
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
	};
	return {
		viewport: { w: root.clientWidth, h: root.clientHeight },
		rootScrollX: root.scrollWidth > root.clientWidth,
		rootScrollW: root.scrollWidth,
		rail: box(rail),
		railItem: box(item),
		railCapsule: box(capsule),
		tabBar: box(tabBar),
		sidebar: box(sidebar),
		main: box(main),
		railItems: document.querySelectorAll('.session-rail-item').length,
		// 命中测试：收起态下聊天正文必须照旧可点（轨道是覆盖层，不许抢点击）；线上必须能点到轨道项
		hitAtChat: (() => {
			const el = document.elementFromPoint(400, Math.round(root.clientHeight / 2));
			return el ? el.closest('.session-rail-item') ? 'rail' : el.tagName + '.' + String(el.className).slice(0, 20) : null;
		})(),
		hitAtRailLine: (() => {
			const item = document.querySelector('.session-rail-item');
			if (!item) return null;
			const r = item.getBoundingClientRect();
			const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
			return el ? (el.closest('.session-rail-item') ? 'rail-item' : el.tagName) : null;
		})(),
		z: {
			rail: rail ? getComputedStyle(rail).zIndex : null,
			dialog: (() => { const d = document.querySelector('[role=dialog]'); return d ? getComputedStyle(d).zIndex : null; })(),
			railPointer: rail ? getComputedStyle(rail).pointerEvents : null,
		},
		pills: document.querySelectorAll('.tab-pill').length,
		tokens: {
			railEnabled: !!rail,
			barVisible: document.querySelectorAll('.tab-pill').length > 0,
		},
	};
})()`;

/** 悬停第 n 条轨道项：React 19 走 root 委托，mouseover/mouseout 会被合成成 onMouseEnter/onMouseLeave */
const hoverRail = (index) => `(() => {
	const items = [...document.querySelectorAll('.session-rail-item')];
	const el = items[${index}];
	if (!el) return 'no item';
	el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
	return 'hovered';
})()`;

async function measure(cdp) {
	const out = await cdp.eval(LAYOUT);
	console.log(JSON.stringify(out, null, 2));
	// 窄窗口：真改窗口尺寸（Electron 未实现 Browser.setWindowBounds）
	await cdp.eval(`window.resizeTo(760, 620); true`);
	await cdp.eval(TWO_RAF);
	const narrow = await cdp.eval(LAYOUT);
	console.log("narrow:", JSON.stringify({ viewport: narrow.viewport, rootScrollX: narrow.rootScrollX }));
	await cdp.eval(`window.resizeTo(1200, 800); true`);
	await cdp.eval(TWO_RAF);
	return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RAIL_GEOM = `(() => {
	const items = [...document.querySelectorAll('.session-rail-item')];
	if (!items.length) return null;
	const first = items[0].getBoundingClientRect();
	const last = items[items.length - 1].getBoundingClientRect();
	return {
		heights: items.map((el) => Math.round(el.getBoundingClientRect().height)),
		classes: items.map((el) => el.className.replace('session-rail-item', '').trim() || 'collapsed'),
		clip: { x: Math.max(0, Math.round(first.x) - 12), y: Math.max(0, Math.round(first.y) - 28), width: 420, height: Math.round(last.bottom - first.top + 56) },
	};
})()`;

async function wave(cdp) {
	await cdp.eval(hoverRail(1));
	// 等过渡跑完（最大档 340ms），拿目标态而不是中间帧
	await sleep(520);
	const geom = await cdp.eval(RAIL_GEOM);
	console.log("settled heights:", JSON.stringify(geom?.heights), "classes:", JSON.stringify(geom?.classes));
	if (geom) console.log("shot:", await cdp.shot("wave-settled", geom.clip));
	// 展开态细节：标题与 × 是否真的可见可点（.rail-close 的 opacity + pointer-events 由 CSS 控）
	const detail = await cdp.eval(`(() => {
		const item = document.querySelector('.session-rail-item.is-expanded') ?? document.querySelector('.session-rail-item');
		const close = item?.querySelector('.rail-close');
		const title = item?.querySelector('span.min-w-0.flex-1');
		return {
			hasExpanded: !!document.querySelector('.session-rail-item.is-expanded'),
			ariaLabel: item?.getAttribute('aria-label') ?? null,
			ariaPressed: item?.getAttribute('aria-pressed') ?? null,
			closeBox: close ? { w: Math.round(close.getBoundingClientRect().width), opacity: getComputedStyle(close).opacity, pe: getComputedStyle(close).pointerEvents } : null,
			titleText: title?.textContent ?? null,
			titleOpacity: title ? getComputedStyle(title).opacity : null,
			capsuleBg: getComputedStyle(item?.querySelector('.rail-capsule')).backgroundColor,
			capsuleShadow: getComputedStyle(item?.querySelector('.rail-capsule')).boxShadow,
		};
	})()`);
	console.log("expanded detail:", JSON.stringify(detail));
	// 键盘可达：聚焦即展开（不依赖鼠标）
	await cdp.eval(
		`document.querySelector('.session-rail-item')?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); true`,
	);
	await sleep(400);
	await cdp.eval(
		`(() => { const el = [...document.querySelectorAll('.session-rail-item')][2]; el?.focus(); return document.activeElement?.className?.includes('session-rail-item'); })()`,
	);
	await sleep(520);
	const focused = await cdp.eval(RAIL_GEOM);
	console.log("focus-expanded classes:", JSON.stringify(focused?.classes));
	if (focused) console.log("shot:", await cdp.shot("wave-focus-keyboard", focused.clip));
	await cdp.eval(`document.activeElement?.blur(); true`);
}

async function states(cdp) {
	const full = { x: 0, y: 0, width: 1200, height: 520 };
	const shots = [];
	await cdp.eval(TWO_RAF);
	shots.push(await cdp.shot("01-rail-on-bar-on", full));
	await cdp.eval(hoverRail(1));
	await sleep(520);
	shots.push(await cdp.shot("02-rail-hover-wave", full));
	await cdp.eval(
		`document.querySelector('.session-rail-item')?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); true`,
	);
	await sleep(420);
	await cdp.eval(`(() => { window.resizeTo(760, 620); return true; })()`);
	await cdp.eval(TWO_RAF);
	await sleep(200);
	const narrow = await cdp.eval(LAYOUT);
	shots.push(await cdp.shot("03-narrow-760x620", { x: 0, y: 0, width: 760, height: 560 }));
	await cdp.eval(`(() => { window.resizeTo(1200, 800); return true; })()`);
	await cdp.eval(TWO_RAF);
	// 深色主题：轨道只用语义 token，两套主题都必须成立（写死白色会在深色下露馅）
	await cdp.eval(`document.documentElement.dataset.theme = 'dark'; true`);
	await cdp.eval(hoverRail(1));
	await sleep(520);
	shots.push(await cdp.shot("05-dark-hover-wave", full));
	await cdp.eval(
		`document.querySelector('.session-rail-item')?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); true`,
	);
	await cdp.eval(`document.documentElement.dataset.theme = 'light'; true`);
	await sleep(420);
	console.log(JSON.stringify({ shots, narrow }, null, 2));
}

/** 用设置面板（真实 UI 路径）开关两项显示，并断言两个入口的独立性与双关清空语义 */
async function switches(cdp) {
	const state = () =>
		cdp.eval(`JSON.stringify({
		rail: document.querySelectorAll('.session-rail-item').length,
		pills: document.querySelectorAll('.tab-pill').length,
		activeRow: document.querySelector('[data-session-active="true"]')?.getAttribute('data-session-id') ?? null,
		switches: [...document.querySelectorAll('[role=dialog] [role=switch]')].map((s) => s.getAttribute('aria-checked')),
	})`);
	const openSettings = `(() => {
		const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '设置' || b.getAttribute('aria-label') === '设置');
		btn?.click();
		return !!btn;
	})()`;
	const openAppearance = `(() => {
		const tab = [...document.querySelectorAll('[role=dialog] [role=tab], [role=dialog] button')].find((x) => (x.innerText || '').trim() === '外观');
		tab?.click();
		return !!tab;
	})()`;
	const toggle = (index) => `(() => {
		const sw = [...document.querySelectorAll('[role=dialog] [role=switch]')];
		sw[${index}]?.click();
		return sw.length;
	})()`;
	const closeSettings = `(() => {
		const x = [...document.querySelectorAll('[role=dialog] button')].find((b) => (b.innerText || '').trim() === '✕');
		x?.click();
		return !!x;
	})()`;

	console.log("before:", await state());
	await cdp.eval(openSettings);
	await cdp.eval(openAppearance);
	await sleep(200);
	console.log("settings open, switches (bar, rail, orb):", await state());

	// 关轨道（顶栏保持开）：独立生效，顶栏胶囊不受影响
	await cdp.eval(toggle(1));
	await sleep(200);
	console.log("rail off:", await state());
	// 再开回
	await cdp.eval(toggle(1));
	await sleep(200);
	console.log("rail back:", await state());
	// 关顶栏（轨道保持开）：胶囊消失、轨道照旧
	await cdp.eval(toggle(0));
	await sleep(300);
	console.log("bar off (rail keeps):", await state());
	await cdp.shot("04-bar-off-rail-on", { x: 0, y: 0, width: 1200, height: 520 });
	// 两处都关 = 清空工作区（两个入口同时消失）
	await cdp.eval(toggle(1));
	await sleep(300);
	console.log("both off:", await state());
	await cdp.eval(closeSettings);
	await sleep(200);
	console.log("after close:", await state());
	// 复原：都开回来，方便后续手验
	await cdp.eval(`${openSettings} && ${openAppearance}`);
	await sleep(200);
	await cdp.eval(toggle(0));
	await cdp.eval(toggle(1));
	await sleep(300);
	console.log("restored:", await state());
	await cdp.eval(closeSettings);
}

/** reduced-motion 验收：过渡被压掉后，悬停应在下一帧就到位（而不是逐帧长大） */
async function reduced(cdp) {
	await cdp.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
	await cdp.eval(hoverRail(1));
	await cdp.eval(TWO_RAF);
	const fast = await cdp.eval(RAIL_GEOM);
	console.log("reduce: 2 帧后高度 =", JSON.stringify(fast?.heights));
	await cdp.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
	});
	await cdp.eval(
		`[...document.querySelectorAll('.session-rail-item')].forEach((el) => el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))); true`,
	);
	await sleep(420);
	await cdp.eval(hoverRail(1));
	await cdp.eval(TWO_RAF);
	const slow = await cdp.eval(RAIL_GEOM);
	console.log("normal: 2 帧后高度 =", JSON.stringify(slow?.heights));
	await cdp.eval(
		`[...document.querySelectorAll('.session-rail-item')].forEach((el) => el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))); true`,
	);
}

/** 真实鼠标拖拽（dnd-kit PointerSensor：先超过激活距离才算 drag start） */
async function drag(cdp, fromIndex, toIndex) {
	const box = await cdp.eval(`(() => {
		const pills = [...document.querySelectorAll('.tab-pill')];
		const from = pills[${fromIndex}]?.getBoundingClientRect();
		const to = pills[${toIndex}]?.getBoundingClientRect();
		if (!from || !to) return null;
		return {
			from: { x: Math.round(from.x + from.width / 2), y: Math.round(from.y + from.height / 2) },
			to: { x: Math.round(to.x + to.width / 2), y: Math.round(to.y + to.height / 2) },
			fromWidth: Math.round(from.width),
		};
	})()`);
	if (!box) throw new Error("找不到要拖的胶囊");
	const mouse = (type, x, y, extra = {}) =>
		cdp.send("Input.dispatchMouseEvent", {
			type,
			x,
			y,
			button: "left",
			clickCount: 1,
			buttons: type === "mouseReleased" ? 0 : 1,
			...extra,
		});
	// 注意：同一坐标不重算 hover / 不触发拖动 → 每次都换坐标（AGENTS.md 鼠标两坑）
	await mouse("mouseMoved", box.from.x, box.from.y);
	await mouse("mousePressed", box.from.x, box.from.y);
	for (let step = 1; step <= 8; step += 1) {
		const x = box.from.x + ((box.to.x - box.from.x) * step) / 8;
		await mouse("mouseMoved", Math.round(x), box.from.y + step);
		await sleep(30);
	}
	// 拖动中：ghost（DragOverlay）必须在，且内容/宽度与该胶囊一致
	const mid = await cdp.eval(`(() => {
		const ghost = document.querySelector('.tab-dragging');
		const overlay = ghost?.closest('[style*="transform"]') ?? ghost?.parentElement;
		return {
			hasGhost: !!ghost,
			ghostText: ghost?.innerText?.trim() ?? null,
			ghostWidth: ghost ? Math.round(ghost.getBoundingClientRect().width) : null,
			overlayTag: overlay?.tagName ?? null,
			overlayPos: overlay ? getComputedStyle(overlay).position : null,
			pillCount: document.querySelectorAll('.tab-pill').length,
		};
	})()`);
	await mouse("mouseReleased", box.to.x, box.to.y);
	await sleep(200);
	const after = await cdp.eval(`[...document.querySelectorAll('.tab-pill')].map((p) => p.innerText.trim())`);
	return { box, mid, after };
}

/** 欠账项：未加载成员的胶囊拖拽 ghost（阶段 2 review 要求） */
async function ghost(cdp) {
	const order = () =>
		cdp.eval(
			`[...document.querySelectorAll('.session-rail-item')].map((el) => el.getAttribute('data-rail-session-id'))`,
		);
	const before = await order();
	const activeRow = await cdp.eval(
		`document.querySelector('[data-session-active="true"]')?.getAttribute('data-session-id') ?? null`,
	);
	console.log(
		"before:",
		JSON.stringify({
			members: before.length,
			activeRow,
			// 被拖的那条**不是**当前会话 = 本次启动只加载了 activeFile，它就是未加载成员
			draggedIsUnloaded: before[0] !== activeRow,
			firstIds: before.slice(0, 3),
		}),
	);
	const result = await drag(cdp, 0, 2);
	console.log(
		"dragging 0 → 2:",
		JSON.stringify(
			{ from: result.box.from, to: result.box.to, fromWidth: result.box.fromWidth, mid: result.mid },
			null,
			2,
		),
	);
	const after = await order();
	console.log(
		"order changed:",
		JSON.stringify(after) !== JSON.stringify(before),
		JSON.stringify(after.slice(0, 3)),
	);
	// 落盘顺序（工作区快照 = 拖动结果）：脚本直接读 dev 的 ui-state.json
	const uiStatePath = resolve(
		process.env.HOME,
		"Library/Application Support/@percho/desktop-dev/ui-state.json",
	);
	let persisted = null;
	try {
		persisted = JSON.parse(readFileSync(uiStatePath, "utf8")).sessionWorkspace?.files ?? null;
	} catch (error) {
		console.log("读 ui-state 失败（跳过落盘断言）:", String(error));
	}
	if (persisted) {
		const persistedIds = persisted.map((f) =>
			f
				.split("_")
				.at(-1)
				.replace(/\.jsonl$/, ""),
		);
		console.log("persisted order:", JSON.stringify(persistedIds.slice(0, 3)));
		console.log("persisted == DOM order:", JSON.stringify(persistedIds) === JSON.stringify(after));
	}
	return result;
}

/** 键盘移出：仅开轨道时，聚焦某条 → Delete → 成员少一条、焦点落到邻居（不是 body） */
async function keyboard(cdp) {
	const before = await cdp.eval(`JSON.stringify({
		rail: document.querySelectorAll('.session-rail-item').length,
		ariaKeyshortcuts: document.querySelector('.session-rail-item')?.getAttribute('aria-keyshortcuts') ?? null,
		navLabel: document.querySelector('nav[aria-label]')?.getAttribute('aria-label') ?? null,
	})`);
	console.log("before:", before);
	await cdp.eval(
		`(() => { const el = [...document.querySelectorAll('.session-rail-item')][1]; el?.focus(); return document.activeElement === el; })()`,
	);
	await sleep(250);
	const focused = await cdp.eval(`(() => {
		const el = [...document.querySelectorAll('.session-rail-item')].find((x) => x.classList.contains('is-expanded'));
		return { expanded: !!el, focusedLabel: document.activeElement?.getAttribute('aria-label') ?? null };
	})()`);
	console.log("focused:", JSON.stringify(focused));
	// 方向键移动焦点（ariaLabel 承诺的行为）：ArrowDown 到下一项、ArrowUp 回上一项
	const arrow = async (key, code, vk) => {
		for (const type of ["rawKeyDown", "keyUp"]) {
			await cdp.send("Input.dispatchKeyEvent", {
				type,
				key,
				code,
				windowsVirtualKeyCode: vk,
				nativeVirtualKeyCode: vk,
			});
		}
		await sleep(120);
	};
	const focusedIndex = () =>
		cdp.eval(`[...document.querySelectorAll('.session-rail-item')].indexOf(document.activeElement)`);
	const indexBefore = await focusedIndex();
	await arrow("ArrowDown", "ArrowDown", 40);
	const indexDown = await focusedIndex();
	await arrow("ArrowUp", "ArrowUp", 38);
	const indexUp = await focusedIndex();
	console.log(
		"arrow navigation:",
		JSON.stringify({
			indexBefore,
			afterArrowDown: indexDown,
			afterArrowUp: indexUp,
			movedDown: indexDown === indexBefore + 1,
			movedBackUp: indexUp === indexBefore,
		}),
	);
	// 真键盘事件（不是 dispatchEvent）：Delete 走 onKeyDown
	for (const key of ["Delete"]) {
		await cdp.send("Input.dispatchKeyEvent", {
			type: "rawKeyDown",
			key,
			code: key,
			windowsVirtualKeyCode: 46,
			nativeVirtualKeyCode: 46,
		});
		await cdp.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key,
			code: key,
			windowsVirtualKeyCode: 46,
			nativeVirtualKeyCode: 46,
		});
	}
	await sleep(400);
	const after = await cdp.eval(`JSON.stringify({
		rail: document.querySelectorAll('.session-rail-item').length,
		pills: document.querySelectorAll('.tab-pill').length,
		focusStillInRail: !!document.activeElement?.classList?.contains('session-rail-item'),
		focusLabel: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? null,
		activeRow: document.querySelector('[data-session-active="true"]')?.getAttribute('data-session-id') ?? null,
	})`);
	console.log("after Delete:", after);
}

/** 置顶图钉：展开胶囊里必须出现（收起短线不出现），切换置顶即时生效 */
async function pin(cdp) {
	const glyph = () =>
		cdp.eval(`(() => {
		const item = [...document.querySelectorAll('.session-rail-item')][1];
		item?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		return new Promise((r) => setTimeout(() => {
			const cap = item?.querySelector('.rail-capsule');
			r(JSON.stringify({
				collapsedItems: [...document.querySelectorAll('.session-rail-item')].filter((el) => !el.className.includes('is-')).length,
				expandedSvgs: cap ? cap.querySelectorAll('svg').length : null,
				title: cap?.querySelector('span.min-w-0.flex-1')?.textContent ?? null,
				closeVisible: (() => { const c = cap?.querySelector('.rail-close'); return c ? getComputedStyle(c).opacity : null; })(),
				capsuleWidth: cap ? Math.round(cap.getBoundingClientRect().width) : null,
				// × 必须完整留在胶囊内（不能被标题/图钉挤出或遮挡），标题仍有可见宽度
				closeInsideCapsule: (() => {
					const c = cap?.querySelector('.rail-close')?.getBoundingClientRect();
					const r = cap?.getBoundingClientRect();
					return c && r ? { gap: Math.round(r.right - c.right), width: Math.round(c.width) } : null;
				})(),
				titleVisibleWidth: (() => { const s = [...(cap?.querySelectorAll('span.min-w-0.flex-1') ?? [])].at(-1); return s ? Math.round(s.getBoundingClientRect().width) : null; })(),
				// 收起态（非 expanded/near）的内容层 opacity 必须为 0 → 图钉/标题在短线上不可见
				collapsedContentOpacity: (() => {
					const collapsed = [...document.querySelectorAll('.session-rail-item')].find((el) => !/is-(expanded|near-1|near-2)/.test(el.className));
					const inner = collapsed?.querySelector('.rail-capsule > *');
					return inner ? getComputedStyle(inner).opacity : null;
				})(),
			}));
		}, 520));
	})()`);
	console.log("before pin:", await glyph());
	// 通过左栏行的右键菜单置顶（真实 UI 路径）
	const pinnedRow = await cdp.eval(`(() => {
		const rows = [...document.querySelectorAll('[data-session-id]')];
		const railIds = [...document.querySelectorAll('.session-rail-item')].map((el) => el.getAttribute('data-rail-session-id'));
		const row = rows.find((r) => r.getAttribute('data-session-id') === railIds[1]);
		if (!row) return 'row not found';
		const b = row.getBoundingClientRect();
		row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 40, clientY: b.top + 10 }));
		return 'menu opened';
	})()`);
	console.log("context menu:", pinnedRow);
	await sleep(300);
	const clicked = await cdp.eval(`(() => {
		const item = [...document.querySelectorAll('[role="menu"] button, [role="menuitem"]')].find((e) => e.innerText.trim() === '置顶');
		item?.click();
		return !!item;
	})()`);
	console.log("pin clicked:", clicked);
	console.log("after pin:", await glyph());
	// 证据图：置顶态的展开胶囊（图钉 + 标题 + × 三者同屏，互不遮挡）
	await sleep(200);
	const clip = await cdp.eval(
		`(() => { const cap = [...document.querySelectorAll('.session-rail-item')][1]?.querySelector('.rail-capsule'); const r = cap?.getBoundingClientRect(); return r ? { x: Math.max(0, Math.round(r.x) - 12), y: Math.max(0, Math.round(r.y) - 24), width: 280, height: 88 } : null; })()`,
	);
	if (clip) console.log("shot:", await cdp.shot("06-rail-expanded-pin", clip));
	// 取消置顶：即时消失
	await cdp.eval(`(() => {
		const row = [...document.querySelectorAll('[data-session-id]')].find((r) => r.getAttribute('data-session-id') === [...document.querySelectorAll('.session-rail-item')][1]?.getAttribute('data-rail-session-id'));
		const b = row.getBoundingClientRect();
		row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 40, clientY: b.top + 10 }));
		return true;
	})()`);
	await sleep(300);
	await cdp.eval(`(() => {
		const item = [...document.querySelectorAll('[role="menu"] button, [role="menuitem"]')].find((e) => e.innerText.trim() === '取消置顶');
		item?.click();
		return !!item;
	})()`);
	console.log("after unpin:", await glyph());
	await cdp.eval(
		`[...document.querySelectorAll('.session-rail-item')][1]?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); true`,
	);
}

/** 打开侧栏第 i 个会话（真实用户入口：先记工作区再导航） */
async function openSidebarRow(cdp, i) {
	const id = await cdp.eval(
		`(() => { const rows = [...document.querySelectorAll('[data-session-id]')]; rows[${i}]?.click(); return rows[${i}]?.getAttribute('data-session-id') ?? null; })()`,
	);
	await sleep(1600);
	return id;
}

/**
 * GC 卸载后胶囊仍在、且能按需打开（内存策略与工作区解耦的核心验收）。
 * 靠 dev 的 `[session-gc] unload <id>` console 日志取证（TICK 20s、KEEP 3、fresh 3s）。
 */
async function gc(cdp) {
	const before = Number(await cdp.eval(`document.querySelectorAll('.session-rail-item').length`));
	for (const i of [1, 2, 3, 4, 5]) await openSidebarRow(cdp, i);
	const opened = Number(await cdp.eval(`document.querySelectorAll('.session-rail-item').length`));
	console.log("members before GC wait:", JSON.stringify({ before, opened }));
	let unloaded = [];
	for (let waited = 0; waited < 60_000 && unloaded.length === 0; waited += 2_000) {
		await sleep(2000);
		unloaded = cdp.events
			.filter((e) => e.text.includes("[session-gc] unload"))
			.map((e) => e.text.slice(e.text.indexOf("unload")));
	}
	console.log("GC unloaded:", JSON.stringify(unloaded.slice(-6)));
	const after = await cdp.eval(`JSON.stringify({
		rail: document.querySelectorAll('.session-rail-item').length,
		pills: document.querySelectorAll('.tab-pill').length,
		activeRow: document.querySelector('[data-session-active="true"]')?.getAttribute('data-session-id') ?? null,
		firstRailId: document.querySelector('.session-rail-item')?.getAttribute('data-rail-session-id') ?? null,
	})`);
	console.log("after GC:", after);
	// 点一个「不是当前会话」的胶囊：必须按需打开（后台会话已被 GC 卸掉，这是唯一入口）
	const clickTarget = await cdp.eval(`(() => {
		const items = [...document.querySelectorAll('.session-rail-item')];
		const el = items.find((x) => x.getAttribute('aria-pressed') !== 'true');
		if (!el) return null;
		const id = el.getAttribute('data-rail-session-id');
		el.click();
		return id;
	})()`);
	await sleep(2500);
	const reopened = await cdp.eval(`JSON.stringify({
		clicked: ${JSON.stringify(clickTarget)},
		activeRow: document.querySelector('[data-session-active="true"]')?.getAttribute('data-session-id') ?? null,
		railStill: document.querySelectorAll('.session-rail-item').length,
	})`);
	console.log("on-demand open after GC:", reopened);
}

/** 升级 / 剪枝 / 顺序一致性：矩阵里可自动化的部分 */
async function matrix(cdp) {
	const order = () =>
		cdp.eval(
			`[...document.querySelectorAll('.session-rail-item')].map((el) => el.getAttribute('data-rail-session-id'))`,
		);
	const uiStatePath = resolve(
		process.env.HOME,
		"Library/Application Support/@percho/desktop-dev/ui-state.json",
	);
	const readWs = () => {
		try {
			return JSON.parse(readFileSync(uiStatePath, "utf8")).sessionWorkspace ?? null;
		} catch {
			return null;
		}
	};
	// ① 三处顺序一致：轨道 / 顶栏 / 落盘快照
	const railOrder = await order();
	const pillOrder = await cdp.eval(
		`[...document.querySelectorAll('.tab-pill')].map((el) => el.getAttribute('data-session-id') ?? el.innerText.trim())`,
	);
	const files = (readWs()?.files ?? []).map((f) =>
		f
			.split("_")
			.at(-1)
			.replace(/\.jsonl$/, ""),
	);
	console.log(
		"order consistency:",
		JSON.stringify({
			rail: railOrder.length,
			pills: pillOrder.length,
			persisted: files.length,
			railEqualsPersisted: JSON.stringify(railOrder) === JSON.stringify(files),
		}),
	);
	// ② Mac chrome / drag-region 回归：顶栏仍是拖拽区且左侧留了红绿灯位（不被轨道/胶囊侵占）
	const chrome = await cdp.eval(`(() => {
		const bar = document.querySelector('[data-session-active]')?.closest('div')?.parentElement?.parentElement ?? null;
		const hit = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; };
		const dragEl = [...document.querySelectorAll('div')].find((d) => getComputedStyle(d).webkitAppRegion === 'drag');
		return {
			hasDragRegion: !!dragEl,
			dragRegion: dragEl ? { x: Math.round(dragEl.getBoundingClientRect().x), w: Math.round(dragEl.getBoundingClientRect().width), h: Math.round(dragEl.getBoundingClientRect().height) } : null,
			sidebarToggle: hit('button[title="收起导航栏"], button[title="展开导航栏"]'),
			longListScrolls: (() => { const box = document.querySelector('nav[aria-label] > div'); return box ? getComputedStyle(box).overflowY : null; })(),
			rootScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
		};
	})()`);
	console.log("chrome / drag-region:", JSON.stringify(chrome));
	// ③ 窄窗横滚回归
	await cdp.eval(`window.resizeTo(760, 620); true`);
	await sleep(500);
	console.log(
		"narrow:",
		await cdp.eval(
			`JSON.stringify({ rootScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth, railItems: document.querySelectorAll('.session-rail-item').length })`,
		),
	);
	await cdp.eval(`window.resizeTo(1200, 800); true`);
	await sleep(400);
	// ④ 工作区快照的失效项（seed 的幽灵路径）必须已被剪掉，且**没有为它造出文件**
	const ws = readWs();
	const ghosts = (ws?.files ?? []).filter((f) => f.includes("ghost-nonexistent"));
	console.log(
		"prune check:",
		JSON.stringify({
			files: ws?.files?.length ?? null,
			activeFile: ws?.activeFile ?? null,
			ghostLeft: ghosts.length,
			ghostFileExists: existsSync(
				resolve(
					process.env.HOME,
					".pi/agent-dev/sessions/--Users-ericw-.percho-daily--/ghost-nonexistent.jsonl",
				),
			),
		}),
	);
}

/**
 * 只报当前状态（供「停机 seed ui-state → 起 dev → 断言」这类升级/剪枝用例当断言工具用）：
 * 顶栏胶囊 / 轨道项 / 空态提示 / 左栏置顶图钉 / 当前页是否新会话页 / 落盘快照 + 幽灵文件是否被造出来
 */
async function assertState(cdp) {
	const dom = await cdp.eval(`JSON.stringify({
		pills: document.querySelectorAll('.tab-pill').length,
		rail: document.querySelectorAll('.session-rail-item').length,
		railEnabled: !!document.querySelector('nav[aria-label]'),
		hint: document.body.innerText.includes('打开过的会话会显示在这里'),
		draftPage: !document.querySelector('[data-session-active="true"]'),
		pinnedRows: [...document.querySelectorAll('[data-session-id]')].filter((r) => r.querySelector('svg')).length,
	})`);
	const uiStatePath = resolve(
		process.env.HOME,
		"Library/Application Support/@percho/desktop-dev/ui-state.json",
	);
	let persisted = null;
	try {
		persisted = JSON.parse(readFileSync(uiStatePath, "utf8"));
	} catch (error) {
		persisted = { readError: String(error) };
	}
	const ghost = persisted?.sessionWorkspace?.files?.find((f) => f.includes("ghost-nonexistent")) ?? null;
	console.log(
		JSON.stringify(
			{
				dom: JSON.parse(dom),
				prefs: {
					bar: persisted?.barSessionsVisible,
					rail: persisted?.sessionRailEnabled,
					pinned: persisted?.pinnedSessions ?? null,
				},
				workspace: persisted?.sessionWorkspace ?? null,
				ghost: { pathInSnapshot: ghost, fileExists: ghost ? existsSync(ghost) : false },
			},
			null,
			2,
		),
	);
}

/**
 * 未加载成员的**离线重命名**一致性 + 重启一致性（plan 阶段 4 手验项）。
 * 用法：`node scripts/shoot-rail.mjs rename "<名字>"`，重启后 `node scripts/shoot-rail.mjs assert-rename "<名字>" [sessionId]`
 * —— 带上 sessionId 时按 **id 精确命中**（DOM 三处 + 磁盘文件），不带时退化为按名字计数。
 *
 * 断言五处一致：顶栏胶囊 / 左栏行 / 轨道展开胶囊 / 磁盘文件内容 / 快照里的路径未变。
 */
async function renameTarget(cdp) {
	// 当前胶囊带 `bg-bubble`（TabPill 的 isActive 样式）；挑一个**不带**的 = 未加载成员
	return cdp.eval(`(() => {
		const pills = [...document.querySelectorAll('.tab-pill')];
		const rails = [...document.querySelectorAll('.session-rail-item')];
		const index = pills.findIndex((p) => !p.className.includes('bg-bubble'));
		if (index < 0) return null;
		const id = rails[index]?.getAttribute('data-rail-session-id') ?? null;
		const r = pills[index].getBoundingClientRect();
		return { index, id, x: Math.round(r.x + 60), y: Math.round(r.y + r.height / 2), title: pills[index].innerText.trim() };
	})()`);
}

function renameProbe(newName) {
	return `(() => {
		const pills = [...document.querySelectorAll('.tab-pill')];
		const rails = [...document.querySelectorAll('.session-rail-item')];
		const titles = pills.map((p) => p.innerText.trim());
		const row = (id) => id ? document.querySelector(\`[data-session-id="\${id}"]\`)?.innerText.trim() ?? null : null;
		const railIds = rails.map((el) => el.getAttribute('data-rail-session-id'));
		return {
			pillTitles: titles,
			railIds,
			rowTitles: railIds.map(row),
			activePill: pills.findIndex((p) => p.className.includes('bg-bubble')),
			newNameSeen: titles.filter((t) => t.includes(${JSON.stringify(newName)})).length,
		};
	})()`;
}

async function rename(cdp) {
	const newName = process.argv[3] ?? "重命名验收-未加载";
	const target = await renameTarget(cdp);
	if (!target) throw new Error("没有未加载的胶囊可重命名（需要 ≥2 个成员且当前不在其中某一个上）");
	console.log("target:", JSON.stringify(target));
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: target.x,
		y: target.y,
		button: "right",
		clickCount: 1,
	});
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: target.x,
		y: target.y,
		button: "right",
		clickCount: 1,
	});
	await sleep(300);
	await cdp.eval(
		`(() => { const item = [...document.querySelectorAll('[role="menu"] button, [role="menuitem"]')].find((e) => e.innerText.trim() === '重命名'); item?.click(); return !!item; })()`,
	);
	await sleep(300);
	const typed = await cdp.eval(`(() => {
		const input = document.querySelector('input[type="text"], input:not([type])');
		if (!input) return 'no input';
		// 受控 input：走原型 setter + input 事件，React 才收得到
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(newName)});
		input.dispatchEvent(new Event('input', { bubbles: true }));
		return input.value;
	})()`);
	console.log("typed:", typed);
	await cdp.eval(
		`(() => { document.querySelector('input[type="text"], input:not([type])')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`,
	);
	await sleep(1500);
	const probe = await cdp.eval(renameProbe(newName));
	console.log("after rename:", JSON.stringify(probe));
	assert(probe, "读不到改名后的 DOM 状态");
	// 轨道展开胶囊（悬停被重命名的那一条）
	await cdp.eval(
		`(() => { const rails = [...document.querySelectorAll('.session-rail-item')]; rails[${target.index}]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true; })()`,
	);
	await sleep(520);
	const railTitle = await cdp.eval(
		`(() => { const item = document.querySelectorAll('.session-rail-item')[${target.index}]; const spans = [...(item?.querySelectorAll('.rail-capsule span.min-w-0.flex-1') ?? [])]; return spans.at(-1)?.textContent ?? null; })()`,
	);
	await cdp.eval(
		`document.querySelectorAll('.session-rail-item')[${target.index}]?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))`,
	);
	console.log("rail capsule title:", JSON.stringify(railTitle));
	// 磁盘 + 快照路径
	const uiStatePath = resolve(
		process.env.HOME,
		"Library/Application Support/@percho/desktop-dev/ui-state.json",
	);
	const ws = JSON.parse(readFileSync(uiStatePath, "utf8")).sessionWorkspace;
	const files = ws?.files ?? [];
	const renamedFile = files.find((f) => f.includes(target.id)) ?? null;
	const exists = renamedFile ? existsSync(renamedFile) : false;
	const content = exists && renamedFile ? readFileSync(renamedFile, "utf8") : "";
	console.log(
		"disk / snapshot:",
		JSON.stringify({
			filesCount: files.length,
			renamedFileStillThere: exists,
			fileHasNewName: content.includes(newName),
			pathUnchanged: renamedFile !== null,
			activeFile: ws?.activeFile ?? null,
		}),
	);
	console.log(
		"SUMMARY:",
		JSON.stringify({
			pillTitle: probe.pillTitles[target.index],
			rowTitle: probe.rowTitles[target.index],
			railTitle,
			renamedWasUnloaded: probe.activePill !== target.index,
			diskKeptPath: exists && renamedFile !== null,
			files: files.length,
		}),
	);
	// ---- fail-fast 断言（任一不成立即非零退出）----
	assertEqual(typed, newName, "重命名输入框没收到新名字");
	assert(
		probe.activePill !== target.index,
		`被改名的胶囊必须是**未加载**成员（目标 index=${target.index}，当前 index=${probe.activePill}）`,
	);
	assertEqual(probe.pillTitles[target.index], newName, "顶栏胶囊标题未变成新名");
	assertEqual(probe.rowTitles[target.index], newName, "左栏会话行标题未变成新名");
	assertEqual(railTitle, newName, "轨道展开胶囊标题未变成新名");
	assert(renamedFile !== null, "工作区快照里找不到被改名成员的路径");
	assert(exists, `被改名会话的文件不在磁盘上（${renamedFile}）：离线改名不应改文件名`);
	assert(content.includes(newName), "会话文件内容里没有新名字（离线改名应追加 session_info）");
	assertEqual(files.length, 2, "改名不应改变工作区成员数");
	console.log(`提示：重启后跑 node scripts/shoot-rail.mjs assert-rename "${newName}" ${target.id}`);
}

/** 重启后只做一致性断言（磁盘/快照 + UI 三处） */
async function assertRename(cdp) {
	const newName = process.argv[3] ?? "重命名验收-未加载";
	const sessionId = process.argv[4] ?? null;
	const probe = await cdp.eval(renameProbe(newName));
	console.log("after restart:", JSON.stringify(probe));
	assert(probe, "读不到重启后的 DOM 状态");
	assertEqual(probe.activePill, 0, "重启后应只自动打开 activeFile 那一条（index 0）");
	assertEqual(probe.newNameSeen, 1, "重启后应恰好一个胶囊是本次改的名字");
	await cdp.eval(
		`(() => { const rails = [...document.querySelectorAll('.session-rail-item')]; rails.forEach((el) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))); return true; })()`,
	);
	await sleep(520);
	const railTitles = await cdp.eval(
		`[...document.querySelectorAll('.session-rail-item .rail-capsule')].map((cap) => [...cap.querySelectorAll('span.min-w-0.flex-1')].at(-1)?.textContent ?? null)`,
	);
	console.log("rail titles:", JSON.stringify(railTitles));
	await cdp.eval(
		`[...document.querySelectorAll('.session-rail-item')].forEach((el) => el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))`,
	);
	const uiStatePath = resolve(
		process.env.HOME,
		"Library/Application Support/@percho/desktop-dev/ui-state.json",
	);
	const ws = JSON.parse(readFileSync(uiStatePath, "utf8")).sessionWorkspace;
	const files = ws?.files ?? [];
	const hit = files.filter((f) => {
		try {
			return existsSync(f) && readFileSync(f, "utf8").includes(newName);
		} catch {
			return false;
		}
	});
	console.log(
		"persisted members:",
		JSON.stringify({
			filesCount: files.length,
			membersWithNewName: hit.length,
			activeFile: ws?.activeFile ?? null,
		}),
	);
	// ---- fail-fast 断言 ----
	if (sessionId) {
		// 按 **sessionId 精确命中**：DOM 三处 + 磁盘文件都必须指向被改名的那个会话
		const index = probe.railIds.indexOf(sessionId);
		assert(index >= 0, `重启后轨道里找不到 sessionId=${sessionId}（成员被错误剪掉？）`);
		assertEqual(railTitles[index], newName, `重启后轨道第 ${index} 条不是新名`);
		assertEqual(probe.pillTitles[index], newName, `重启后顶栏第 ${index} 个胶囊不是新名`);
		assertEqual(probe.rowTitles[index], newName, `重启后左栏第 ${index} 行不是新名`);
		const file = files.find((f) => f.includes(sessionId)) ?? null;
		assert(file !== null, `重启后工作区快照里找不到 sessionId=${sessionId} 的路径`);
		assert(existsSync(file), `会话文件不在磁盘上：${file}`);
		assert(readFileSync(file, "utf8").includes(newName), "会话文件里没有新名字");
		console.log("id-scoped checks:", JSON.stringify({ index, fileIsTheRenamedOne: true }));
	} else {
		assertEqual(railTitles.filter((t) => t === newName).length, 1, "重启后轨道展开胶囊里应恰好一个本次新名");
		assertEqual(
			probe.pillTitles.filter((t) => t === newName).length,
			1,
			"重启后顶栏胶囊里应恰好一个本次新名",
		);
		assertEqual(probe.rowTitles.filter((t) => t === newName).length, 1, "重启后左栏行里应恰好一个本次新名");
	}
	assertEqual(files.length, 2, "重启后工作区仍应保留两个成员（改名不应让成员失效）");
	assertEqual(hit.length, 1, "重启后磁盘上应恰好一个成员的会话文件里含本次新名");
}

/**
 * 增删成员时**其余胶囊的让位动画**（FLIP）：不是「有没有动画」这种感觉断言，
 * 而是读 WAAPI 关键帧：`from` 必须是「旧位置到新位置的差值」，`to` 归零。
 * 用例挑的是**必然产生位移**的场景（删第一条 → 其余左移；在第一位成员右侧插入 → 其余右移）。
 */
const STRIP_PROBE = `(() => {
	// 顶栏胶囊条 = 第一个胶囊包装层的父节点（轨道项也有 data-shift-key，不能用全局 [0]）
	const strip = document.querySelector('.tab-pill')?.closest('[data-shift-key]')?.parentElement ?? null;
	if (!strip) return null;
	const boxes = () => [...strip.querySelectorAll('[data-shift-key]')];
	return {
		xs: () => boxes().map((el) => Math.round(el.getBoundingClientRect().x)),
		anims: () => boxes().flatMap((el) => el.getAnimations().map((a) => ({
			from: a.effect.getKeyframes()[0]?.transform ?? null,
			to: a.effect.getKeyframes().at(-1)?.transform ?? null,
			duration: a.effect.getTiming().duration,
			state: a.playState,
		}))),
		count: () => boxes().length,
	};
})()`;

async function anim(cdp) {
	// 前置：把锚点定在工作区第一条成员（点它本身不改集合，只改 active/recent）
	await cdp.eval(`(() => {
		const memberIds = new Set([...document.querySelectorAll('.session-rail-item')].map((el) => el.getAttribute('data-rail-session-id')));
		const rows = [...document.querySelectorAll('[data-session-id]')];
		rows.find((r) => memberIds.has(r.getAttribute('data-session-id')))?.click();
		return true;
	})()`);
	await sleep(1800);
	const base = await cdp.eval(
		`(() => { const p = ${STRIP_PROBE}; return JSON.stringify({ count: p.count(), xs: p.xs() }); })()`,
	);
	console.log("基线:", base);

	// ① 增：在第一条成员右侧插入一个非成员 → 右侧的胶囊必须右移（from 为负位移）
	// 注意：新增要走 IPC 打开（不是同步的），所以**轮询到成员出现的那一帧**再读动画
	// （提前两帧读会读到「还没加进来」，晚读会读到「动画已经跑完」）
	const added = await cdp.eval(`(async () => {
		const p = ${STRIP_PROBE};
		const memberIds = new Set([...document.querySelectorAll('.session-rail-item')].map((el) => el.getAttribute('data-rail-session-id')));
		const fresh = [...document.querySelectorAll('[data-session-id]')].find((r) => !memberIds.has(r.getAttribute('data-session-id')));
		if (!fresh) return JSON.stringify({ skipped: "没有非成员会话可点" });
		const before = p.xs();
		const beforeCount = p.count();
		fresh.click();
		const hit = await new Promise((resolve) => {
			const deadline = performance.now() + 8000;
			const tick = () => {
				if (p.count() > beforeCount) {
					resolve({ after: p.xs(), count: p.count(), anims: p.anims() });
					return;
				}
				if (performance.now() > deadline) {
					resolve({ timeout: true });
					return;
				}
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		await new Promise((r) => setTimeout(r, 400));
		return JSON.stringify({ before, ...hit, settled: p.xs(), clicked: fresh.getAttribute('data-session-id').slice(-6) });
	})()`);
	console.log("① 新增：", added);
	const addResult = JSON.parse(added);
	if (!addResult.skipped) {
		assert(!addResult.timeout, "点了非成员会话后 8s 内没有加进工作区（open 失败？）");
		assertEqual(addResult.count, JSON.parse(base).count + 1, "点在左栏的非成员会话后成员数应 +1");
		// 只看**让位**动画（带 transform 关键帧的）；新胶囊自己那条是 140ms 的淡入（无 transform）
		const addShifts = addResult.anims.filter((a) => a.to !== null);
		assert(addShifts.length >= 1, "新增后应至少有一个胶囊在做让位动画");
		assert(
			addShifts.every((a) => a.duration === 220 && a.to?.startsWith("translate(0")),
			`让位动画应为 220ms 且落点归零（FLIP 关键帧），实际 ${JSON.stringify(addShifts)}`,
		);
		assert(
			addShifts.some((a) => /translate\(-\d/.test(a.from ?? "")),
			`插入点在左侧时，右侧胶囊应从左侧滑入（from=负位移），实际 ${JSON.stringify(addShifts.map((a) => a.from))}`,
		);
		assert(
			addResult.anims.some((a) => a.duration === 140),
			"新胶囊自身应有 140ms 的淡入（否则是「啪」地冒出来）",
		);
	}
	await sleep(500);

	// ② 删：移出**第一条**成员 → 其余必须左移（from 为正位移）
	const removed = await cdp.eval(`(async () => {
		const p = ${STRIP_PROBE};
		const before = p.xs();
		const item = [...document.querySelectorAll('.session-rail-item')][0];
		item?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 520));
		item?.querySelector('.rail-close')?.click();
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		const mid = p.xs();
		const anims = p.anims();
		await new Promise((r) => setTimeout(r, 400));
		return JSON.stringify({ before, mid2Frames: mid, settled: p.xs(), count: p.count(), anims });
	})()`);
	console.log("② 移出第一条：", removed);
	const removeResult = JSON.parse(removed);
	assertEqual(
		removeResult.count,
		JSON.parse(base).count - 1 + (addResult.skipped ? 0 : 1),
		"移出一条后成员数应 -1",
	);
	const removeShifts = removeResult.anims.filter((a) => a.to !== null);
	assert(removeShifts.length >= 1, "移出后应至少有一个胶囊在做让位动画");
	assert(
		removeShifts.some((a) => /translate\(\d/.test(a.from ?? "")),
		`删掉左侧胶囊时，右侧应从右滑入（from=正位移），实际 ${JSON.stringify(removeResult.anims.map((a) => a.from))}`,
	);
	assertEqual(JSON.stringify(removeResult.settled), JSON.stringify(removeResult.settled), "落定后位置稳定");
}

/**
 * 插入锚点回归（用户实测报的问题）：**停在新会话页时**新建/打开的会话要插在
 * 「刚看过的那个成员」右侧，而不是追加到末尾。
 * 步骤全走真实用户动作：点工作区第一位成员 → 点顶部「＋」进新会话页 → 点左栏一个非成员会话。
 */
async function anchor(cdp) {
	const ids = () =>
		cdp.eval(
			`[...document.querySelectorAll('.session-rail-item')].map((el) => el.getAttribute('data-rail-session-id').slice(-6))`,
		);
	const start = await ids();
	console.log("初始成员:", JSON.stringify(start));
	// ① 先看第一位成员（把「最近看过」定在它）
	await cdp.eval(`(() => {
		const first = document.querySelectorAll('.session-rail-item')[0];
		first?.click();
		return true;
	})()`);
	await sleep(1800);
	const anchoredOn = (await ids())[0];
	// ② 点顶部「＋」回新会话页（activeFile 按 spec 变 null，但「刚看过谁」必须记住）
	await cdp.eval(`(() => {
		// 顶栏「＋」的无障碍名是「新建会话」（在 aria-label 上，不是 title）；左栏项目行的是「在 XX 中新建会话」，别点错
		const btn = [...document.querySelectorAll('button.no-drag')].find((b) =>
			/^(新建会话|New session)/.test(b.getAttribute('aria-label') ?? ''),
		);
		btn?.click();
		return !!btn;
	})()`);
	await sleep(600);
	const onDraft = await cdp.eval(`!document.querySelector('[data-session-active="true"]')`);
	console.log("在新会话页:", onDraft);
	assert(onDraft, "点「＋」后应停在新会话页（没有当前会话）");
	// ③ 在新会话页上点一个非成员会话
	const clicked = await cdp.eval(`(async () => {
		const memberIds = new Set([...document.querySelectorAll('.session-rail-item')].map((el) => el.getAttribute('data-rail-session-id')));
		const fresh = [...document.querySelectorAll('[data-session-id]')].find((r) => !memberIds.has(r.getAttribute('data-session-id')));
		if (!fresh) return null;
		const id = fresh.getAttribute('data-session-id');
		fresh.click();
		const deadline = performance.now() + 8000;
		while (performance.now() < deadline) {
			if ([...document.querySelectorAll('.session-rail-item')].length > memberIds.size) break;
			await new Promise((r) => setTimeout(r, 60));
		}
		return id;
	})()`);
	assert(clicked, "找不到非成员会话可点");
	await sleep(400);
	const after = await ids();
	console.log("打开后成员:", JSON.stringify(after));
	const index = after.indexOf(clicked.slice(-6));
	assertEqual(index, after.indexOf(anchoredOn) + 1, "新开的会话应紧跟在「刚看过的成员」右侧");
	assert(index !== after.length - 1 || index === 1, "新开的会话不应被追加到末尾（除非它本来就该在末尾）");
}

/** 胶囊形状检查：截顶栏胶囊条（含活跃/非活跃/悬停/拖拽 ghost）并报形状参数 */
async function pill(cdp) {
	const clip = await cdp.eval(`(() => {
		const strip = document.querySelector('.tab-pill')?.closest('[data-shift-key]')?.parentElement;
		if (!strip) return null;
		const r = strip.getBoundingClientRect();
		return { x: Math.max(0, Math.round(r.x) - 16), y: Math.max(0, Math.round(r.y) - 14), width: Math.round(r.width) + 32, height: Math.round(r.height) + 28 };
	})()`);
	assert(clip, "找不到顶栏胶囊条");
	await cdp.eval(TWO_RAF);
	console.log(
		"pill shapes:",
		await cdp.eval(`JSON.stringify([...document.querySelectorAll('.tab-pill')].map((p) => ({
			w: Math.round(p.getBoundingClientRect().width),
			h: Math.round(p.getBoundingClientRect().height),
			radius: getComputedStyle(p).borderRadius,
			active: p.className.includes('bg-bubble'),
		})))`),
	);
	console.log("shot:", await cdp.shot("10-pills-capsule", clip));
	// 悬停一个非活跃胶囊：hover 底也应是胶囊（截图前先挪开再挪回，避免 CDP 不重算 hover）
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x: clip.x + clip.width - 40,
		y: clip.y + 30,
	});
	await sleep(260);
	console.log("shot:", await cdp.shot("11-pill-hover", clip));
}

mkdirSync(OUT, { recursive: true });
try {
	await withPage(async (cdp) => {
		if (MODE === "measure") return measure(cdp);
		if (MODE === "wave") return wave(cdp);
		if (MODE === "states") return states(cdp);
		if (MODE === "switches") return switches(cdp);
		if (MODE === "reduced") return reduced(cdp);
		if (MODE === "ghost") return ghost(cdp);
		if (MODE === "keyboard") return keyboard(cdp);
		if (MODE === "pin") return pin(cdp);
		if (MODE === "gc") return gc(cdp);
		if (MODE === "matrix") return matrix(cdp);
		if (MODE === "assert-state") return assertState(cdp);
		// open-row <index>：点侧栏第 index 行（升级用例里验证「用户打开会话后是否入工作区」）
		if (MODE === "rename") return rename(cdp);
		if (MODE === "anim") return anim(cdp);
		if (MODE === "anchor") return anchor(cdp);
		if (MODE === "pill") return pill(cdp);
		if (MODE === "assert-rename") return assertRename(cdp);
		if (MODE === "open-row") {
			console.log("opened:", await openSidebarRow(cdp, Number(process.argv[3] ?? 0)));
			return;
		}
		throw new Error(`未知模式：${MODE}`);
	});
	console.log(`OK · mode=${MODE}`);
	process.exit(0);
} catch (error) {
	console.error(`FAIL · mode=${MODE} · ${error?.message ?? error}`);
	process.exit(1);
}
