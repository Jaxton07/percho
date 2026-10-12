#!/usr/bin/env node
/**
 * 频道订阅胶囊 + 右上堆叠的**真机验收**（spec D2 / plan 阶段 4）。
 *
 * 前置：dev 带远程调试端口启动（别用 `npm run dev -- --xxx`，参数会被 npm 吞掉）：
 *   cd packages/desktop && npx electron-vite dev -- --remote-debugging-port=9224
 * 跑：
 *   node scripts/verify-channel-pill.mjs            # 全量（含 Todo 几何复跑）
 *   node scripts/verify-channel-pill.mjs --no-shots # 跳过截图
 *
 * 证据分层（真话要说清）：
 * - **真实**：会话/消息/工作区、IPC 查询与事件、TodoPanel 槽位、CornerStack/胶囊组件、CSS 过渡与 reduced-motion；
 * - **合成**：订阅内容本身（dev 里没有真实订阅，真要产生得让 agent 调 channel-watch 工具 ——
 *   那条链路由 backend 的真实工具集成测试覆盖：`packages/backend/test/channel-watch-extension.test.ts`
 *   的「真实 channel_subscribe / channel_unsubscribe 驱动 registry」），以及 Todo 列表与插件槽位覆盖。
 *
 * 判定口径：几何/动画一律用**帧后采样**（`setTimeout(0)` 紧跟该帧渲染之后读 rect）做断言；
 * rAF 回调里读到的是上一帧写值，只用来报告（阶段 0 已证明它是采样伪影）。
 * 只写隔离的 dev 数据（dev userData / ~/.pi/agent-dev），正式目录零写入。
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PORT = Number(process.env.CDP_PORT ?? 9224);
const SHOT_DIR = resolve(import.meta.dirname, "..", ".local", "tmp");
const WITH_SHOTS = !process.argv.includes("--no-shots");

/* ---------------- 页面脚本（用 toString 注入，绕开模板串转义坑） ---------------- */
async function pageScript() {
	const R = { steps: [], notes: [], env: {} };
	const E = (cond, message) => {
		if (!cond) throw new Error(`断言失败：${message}`);
	};
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const raf = () => new Promise((r) => requestAnimationFrame(r));
	const twoRaf = async () => {
		await raf();
		await raf();
	};

	const stores = window.PerchoUI.stores;
	const { useSessionsStore, useTranscriptStore } = stores;
	const { useChannelSubscriptionsStore } = await import("/src/stores/channel-subscriptions.ts");
	const registryMod = await import("/src/plugins/registry.ts");
	const uiPluginsMod = await import("/src/stores/ui-plugins.ts");

	const PILL = ".channel-pill";
	const pill = () => document.querySelector(PILL);
	const stack = () =>
		Array.from(document.querySelectorAll("main > div")).find(
			(el) => el.className.includes("items-end") && el.className.includes("right-4"),
		);
	const active = () => useSessionsStore.getState().activeSessionId;
	const rectOf = (el) => {
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
	};
	/**
	 * TodoPanel 的渲染根 = `display: contents` 槽位宿主的**第一个元素子节点**。
	 * **不要**按文本找（探针自己的 transcript 里就写着「验证任务」，会误命中 MessageList）；多根/插件场景
	 * 另有 `[data-probe-todo]` 可用（见 H/I 段）。
	 */
	const todoRoot = () => document.querySelector('main > div[style*="contents"] > *');

	const step = (name, extra) => R.steps.push({ name, ...(extra ?? {}) });

	/* ---- 采样器：帧内（rAF，只报告）+ 帧后（setTimeout(0)，主判据） ---- */
	const sample = () => {
		const p = pill();
		const t = todoRoot();
		const s = stack();
		const names = p?.querySelector("span.truncate") ?? null;
		return {
			activeId: active(),
			pillPresent: !!p,
			pillText: p?.textContent ?? null,
			pillRect: rectOf(p),
			stackTop: s ? Number.parseFloat(getComputedStyle(s).top) : null,
			stackInlineTop: s ? s.style.top : null,
			todoBottom: t ? t.getBoundingClientRect().bottom : null,
			nameScroll: names ? { scroll: names.scrollWidth, client: names.clientWidth } : null,
		};
	};
	const sampleDuring = async (ms, kick) => {
		const paint = [];
		const start = performance.now();
		let running = true;
		const tick = () => {
			paint.push(sample());
			if (performance.now() - start < ms) setTimeout(tick, 0);
			else running = false;
		};
		setTimeout(tick, 0);
		await twoRaf();
		kick?.();
		while (performance.now() - start < ms || running) await sleep(10);
		return paint;
	};

	const main = document.querySelector("main");
	const activeId = active();
	E(activeId, "没有活跃会话（probe 应先打开一个会话）");
	R.env.activeSessionId = activeId;

	// 每轮都从「干净状态」开始：清掉上一轮注入的快照，再走一次**真实**查询把状态种回来
	// （等价于 renderer reload 之后的恢复路径，顺带验证它不依赖曾收到事件）
	useChannelSubscriptionsStore.setState({ bySession: {}, lifecycles: {}, forgetTokens: {} });
	const { syncActiveSession } = await import("/src/stores/channel-subscriptions.ts");
	await syncActiveSession(activeId);
	await twoRaf();

	try {
		/* ============ A. 真实状态：后端真的没有订阅 ⇒ 不该有胶囊 ============ */
		const realSnapshot = await window.pi.getChannelSubscriptions({ sessionId: activeId });
		R.env.realSnapshot = realSnapshot;
		E(Array.isArray(realSnapshot.topics), "真实查询没回快照");
		E(pill() === null, "真实状态（无订阅）下不该出现胶囊");
		step("A 真实无订阅 ⇒ 无胶囊", { topics: realSnapshot.topics });

		/* ============ B/C. 注入订阅 ⇒ 胶囊出现 + 宽度动画（右缘固定） ============ */
		const TOPICS = ["qol3-pill-alpha", "channel-subscription-pill"];
		// 代次统一递增：同一会话内每次注入都更新 ⇒ 清理那次不会被判成「更旧」而拒绝（否则胶囊不退场）
		let injectGeneration = realSnapshot.generation;
		let injectRevision = realSnapshot.revision;
		const inject = (topics, sessionId = active()) =>
			useChannelSubscriptionsStore.getState().apply({
				sessionId,
				live: true,
				topics,
				revision: ++injectRevision,
				generation: ++injectGeneration,
			});

		const frames = await sampleDuring(800, () => inject(TOPICS));
		const present = frames.filter((f) => f.pillPresent);
		E(present.length > 10, `注入后胶囊没有出现（帧数 ${present.length}）`);
		const first = present[0];
		const last = present[present.length - 1];
		E(
			first.pillRect.width < last.pillRect.width * 0.9,
			`宽度没有从 0 展开（${first.pillRect.width} → ${last.pillRect.width}）`,
		);
		const rightEdges = present.map((f) => f.pillRect.right);
		const rightSpread = Math.max(...rightEdges) - Math.min(...rightEdges);
		const widths = present.map((f) => f.pillRect.width);
		const grew = Math.max(...widths) - Math.min(...widths);
		E(rightSpread < 1.5, `右缘在展开过程中移动了（spread ${rightSpread}，宽度变化 ${grew}）`);
		E(
			last.pillText.includes(TOPICS[0]) && last.pillText.includes(TOPICS[1]),
			`胶囊文字缺频道名：${last.pillText}`,
		);
		E(last.pillText.includes("·"), `多频道之间没有间隔点：${last.pillText}`);
		// 胶囊高度由字号 token 连带的 line-height 决定（本项目字号只走 token）：12px × 1.5 + 上下 7px = 32px
		// （设计稿的 ~28px 是 normal line-height 的结果，不是硬指标；这里按实际值断言并记录）
		E(last.pillRect.height >= 26 && last.pillRect.height <= 34, `胶囊高度异常：${last.pillRect.height}`);
		const todo = todoRoot();
		if (todo) {
			E(
				Math.abs(last.pillRect.right - (main.getBoundingClientRect().right - 16)) < 1.5,
				`胶囊右缘没有与 Todo 同缘（right-4）：${last.pillRect.right}`,
			);
		}
		const dur = present[present.length - 1];
		step("B/C 注入后展开", {
			frames: present.length,
			widthFrom: Math.round(first.pillRect.width * 10) / 10,
			widthTo: Math.round(last.pillRect.width * 10) / 10,
			rightSpread: Math.round(rightSpread * 100) / 100,
			height: Math.round(dur.pillRect.height * 10) / 10,
		});

		/* ============ D. 退场：保留退场文本，收起后卸载 ============ */
		const leaveFrames = await sampleDuring(700, () => inject([]));
		const mid = leaveFrames[Math.floor(leaveFrames.length / 2)];
		if (window.__qol3ReducedMotion) {
			// reduced-motion：过渡被关掉，退场应当立即完成（没有「保留退场文本」这一步）
			E(leaveFrames.filter((f) => f.pillPresent).length <= 3, "reduced-motion 下退场没有立即完成");
		} else {
			E(mid.pillPresent, "退场中胶囊立刻消失了（应保留退场文本）");
			E(mid.pillText?.includes(TOPICS[0]), `退场中丢了文本：${mid.pillText}`);
			E(!pill()?.className.includes("channel-pill-open"), "退场中还在用展开类");
			E(mid.pillRect.width < present[present.length - 1].pillRect.width, "退场中宽度没有开始回收");
		}
		const tail = leaveFrames[leaveFrames.length - 1];
		E(!tail.pillPresent, "收起结束后胶囊还在");
		step("D 退场", {
			midWidth: mid.pillRect ? Math.round(mid.pillRect.width) : null,
			finalPresent: tail.pillPresent,
		});

		/* ============ E. 中断：收起途中又订阅回来，旧 timer 不得删掉新胶囊 ============ */
		inject(TOPICS);
		await twoRaf();
		inject([]);
		await sleep(120);
		inject([TOPICS[1]]);
		await twoRaf(); // 新胶囊挂载本身要一帧；这不属于「旧 timer 删掉新胶囊」
		const after = await sampleDuring(700, undefined);
		const gap = after.filter((f) => !f.pillPresent).length;
		E(gap === 0, `中断期间胶囊被卸载了 ${gap} 帧（旧 timer 删掉了新胶囊）`);
		E(pill()?.textContent?.includes(TOPICS[1]), `中断后胶囊内容不是新的：${pill()?.textContent}`);
		step("E 中断接续", { missingFrames: gap, text: pill()?.textContent });

		/* ============ F. reduced-motion：跳过过渡、立即清理（由 runner 切媒体特性） ============ */
		if (window.__qol3ReducedMotion) {
			inject([TOPICS[0]]);
			await twoRaf();
			const fastIn = sample();
			inject([]);
			await twoRaf();
			const fastOut = sample();
			E(fastIn.pillPresent, "reduced-motion 下胶囊没出现");
			E(!fastOut.pillPresent, "reduced-motion 下退场没有立即清理");
			step("F reduced-motion", {
				inWidth: Math.round(fastIn.pillRect.width),
				outPresent: fastOut.pillPresent,
			});
			inject(TOPICS); // 后续几何段需要胶囊在场
		}
		inject(TOPICS); // 兜底：几何段必须有胶囊

		/* ============ G. 几何跟随：真实 TodoPanel 短/长列表动画逐帧（阶段 0 断言的复跑） ============ */
		const SHORT = [
			{ content: "验证任务 01 · 胶囊跟随 Todo 底边", status: "completed" },
			{ content: "验证任务 02 · 长列表触顶 max-h-72", status: "in_progress" },
			{ content: "验证任务 03 · 无 Todo 回到 top-2", status: "pending" },
		];
		const LONG = Array.from({ length: 12 }, (_, i) => ({
			content: `验证任务 ${String(i + 1).padStart(2, "0")} · 长列表触顶验证跟随`,
			status: i < 3 ? "completed" : "pending",
		}));
		const setTodos = async (items) => {
			useTranscriptStore.getState().loadTodos(active(), items);
			await twoRaf();
		};
		const setExpanded = async (open) => {
			stores.useUiStore.setState((s) => ({ todoExpanded: { ...s.todoExpanded, [active()]: open } }));
			await twoRaf();
		};
		for (const [label, items] of [
			["短列表", SHORT],
			["长列表", LONG],
		]) {
			await setTodos(items);
			await setExpanded(false);
			await sleep(450);
			const collapsed = sample();
			const framesG = await sampleDuring(800, () => {
				stores.useUiStore.setState((s) => ({ todoExpanded: { ...s.todoExpanded, [active()]: true } }));
			});
			await sleep(450);
			const expanded = sample();
			const withTodo = framesG.filter((f) => f.todoBottom !== null && f.pillPresent);
			const devs = withTodo.map((f) => Math.round((f.pillRect.top - (f.todoBottom + 8)) * 100) / 100);
			const maxAbs = Math.max(...devs.map(Math.abs));
			E(withTodo.length > 20, `${label}：跟随采样帧数不足 ${withTodo.length}`);
			if (maxAbs > 1) {
				const worst = withTodo.reduce(
					(acc, f) =>
						Math.abs(f.pillRect.top - (f.todoBottom + 8)) > Math.abs(acc.pillRect.top - (acc.todoBottom + 8))
							? f
							: acc,
					withTodo[0],
				);
				throw new Error(
					`断言失败：${label}：胶囊没贴住 Todo 底边 +8（最大偏差 ${maxAbs}，最差帧 ` +
						`pillTop=${Math.round(worst.pillRect.top * 10) / 10} todoBottom=${Math.round(worst.todoBottom * 10) / 10} ` +
						`stackInlineTop=${worst.stackInlineTop}）`,
				);
			}
			E(expanded.todoBottom - collapsed.todoBottom > 40, `${label}：Todo 高度没变化，断言不成立`);
			step(`G ${label} 逐帧跟随`, {
				frames: withTodo.length,
				maxAbsDeviation: maxAbs,
				todoBottomCollapsed: Math.round(collapsed.todoBottom),
				todoBottomExpanded: Math.round(expanded.todoBottom),
			});
		}
		await setExpanded(false);
		await sleep(400);

		/* ============ H. 多根槽位：取所有可占位根的最大 bottom ============ */
		const MultiRootTodo = () =>
			window.PerchoUI.React.createElement(
				window.PerchoUI.React.Fragment,
				null,
				window.PerchoUI.React.createElement("div", {
					"data-probe-todo": "1",
					className: "absolute top-2 right-4 z-20 rounded-xl bg-surface shadow-pop",
					style: { width: "160px", height: "60px" },
				}),
				window.PerchoUI.React.createElement("div", {
					"data-probe-todo": "2",
					className: "absolute top-2 right-4 z-20 rounded-xl bg-surface shadow-pop",
					style: { width: "90px", height: "140px", marginTop: "80px" },
				}),
			);
		registryMod.useUiPluginRegistry.setState({
			overrides: {
				"chat.todo-panel": {
					pluginName: "probe-phase4",
					exportName: "MultiRootTodo",
					component: MultiRootTodo,
				},
			},
		});
		uiPluginsMod.useUiPluginsStore.setState((s) => ({ config: { ...s.config, enabled: true } }));
		await setTodos(SHORT);
		await sleep(400);
		const probeTodos = () => Array.from(document.querySelectorAll("[data-probe-todo]"));
		E(probeTodos().length === 2, `多根插件没有渲染出两个根：${probeTodos().length}`);
		const bottoms = probeTodos().map((el) => el.getBoundingClientRect().bottom);
		const maxBottom = Math.max(...bottoms);
		const minBottom = Math.min(...bottoms);
		const stackTopNow = sample().stackTop;
		E(maxBottom - minBottom > 40, "两个根高度差不明显，断言不成立");
		E(
			Math.abs(stackTopNow - (maxBottom - main.getBoundingClientRect().top + 8)) < 3,
			`堆叠没有跟随最大底边 +8：${stackTopNow}`,
		);
		step("H 多根槽位", {
			roots: probeTodos().length,
			minBottom: Math.round(minBottom),
			maxBottom: Math.round(maxBottom),
			stackTop: Math.round(stackTopNow),
		});

		/* ============ I. 旧式 absolute 插件：自带定位 + 高度动画也要跟随 ============ */
		const legacyListeners = new Set();
		let legacyHeight = 60;
		const LegacyTodo = () => {
			const [, force] = window.PerchoUI.React.useState(0);
			window.PerchoUI.React.useEffect(() => {
				const fn = () => force((n) => n + 1);
				legacyListeners.add(fn);
				return () => legacyListeners.delete(fn);
			}, []);
			return window.PerchoUI.React.createElement(
				"div",
				{ "data-probe-todo": "legacy", className: "absolute top-2 right-4 z-20" },
				window.PerchoUI.React.createElement("div", {
					className: "overflow-hidden rounded-xl bg-surface shadow-pop",
					style: {
						width: "160px",
						height: `${legacyHeight}px`,
						transition: "height 300ms cubic-bezier(0.4,0,0.2,1)",
					},
				}),
			);
		};
		registryMod.useUiPluginRegistry.setState({
			overrides: {
				"chat.todo-panel": { pluginName: "probe-phase4", exportName: "LegacyTodo", component: LegacyTodo },
			},
		});
		await sleep(400);
		E(probeTodos().length === 1, "旧式插件没接管槽位");
		const legacyFrames = await sampleDuring(700, () => {
			legacyHeight = 200;
			for (const fn of legacyListeners) fn();
		});
		const legacyWithPill = legacyFrames.filter((f) => f.todoBottom !== null && f.pillPresent);
		const legacyDevs = legacyWithPill.map(
			(f) => Math.round((f.pillRect.top - (f.todoBottom + 8)) * 100) / 100,
		);
		E(legacyWithPill.length > 15, `旧插件场景跟随帧数不足 ${legacyWithPill.length}`);
		E(
			Math.max(...legacyDevs.map(Math.abs)) <= 1,
			`旧 absolute 插件：胶囊没贴住 +8（最大偏差 ${Math.max(...legacyDevs.map(Math.abs))}）`,
		);
		step("I 旧式 absolute 插件", {
			frames: legacyWithPill.length,
			maxAbsDeviation: Math.max(...legacyDevs.map(Math.abs)),
		});

		/* ============ J. 无 Todo：基线位置 + 贡献的 56px 领先 ============ */
		registryMod.useUiPluginRegistry.setState({ overrides: {} });
		await setTodos([]);
		await sleep(400);
		E(todoRoot() === null, "清空 todos 后 Todo 还在");
		const Contribution = () =>
			window.PerchoUI.React.createElement("div", {
				"data-probe-contrib": "1",
				style: { width: "120px", height: "24px", background: "rgb(230,230,233)" },
			});
		registryMod.useUiPluginRegistry.setState({
			contributions: {
				"chat.corner.top-right": [
					{ pluginName: "probe-phase4", id: "c1", exportName: "Contribution", component: Contribution },
				],
			},
		});
		await sleep(300);
		const contrib = () => document.querySelector("[data-probe-contrib]");
		E(contrib(), "右上贡献没渲染");
		// 有胶囊：胶囊占 Todo 原位置（top-2），贡献排在胶囊下方
		const withPill = sample();
		const withPillContribTop = rectOf(contrib()).top - main.getBoundingClientRect().top;
		E(Math.abs(withPill.stackTop - 8) < 1, `无 Todo 时堆叠没回到 top-2：${withPill.stackTop}`);
		E(
			Math.abs(withPill.pillRect.top - main.getBoundingClientRect().top - 8) < 1.5,
			"无 Todo 时胶囊没占原 Todo 位置",
		);
		E(
			withPillContribTop >= withPill.pillRect.bottom - main.getBoundingClientRect().top + 6,
			"贡献与胶囊重叠了",
		);
		inject([]); // 收起胶囊
		await sleep(600);
		E(pill() === null, "退订后胶囊还在");
		const contribTopNoPill = rectOf(contrib()).top - main.getBoundingClientRect().top;
		E(Math.abs(contribTopNoPill - 56) < 2, `无 Todo 无胶囊时贡献没保留 56px 基线：${contribTopNoPill}`);
		step("J 无 Todo 基线", {
			stackTop: withPill.stackTop,
			contribWithPill: Math.round(withPillContribTop),
			contribWithoutPill: Math.round(contribTopNoPill),
		});

		/* ============ K. 不挡点击 / 不制造横向滚动 ============ */
		inject(TOPICS);
		await sleep(500);
		const stackEl = stack();
		E(getComputedStyle(stackEl).pointerEvents === "none", "堆叠容器不是 pointer-events:none（会挡下方点击）");
		E(getComputedStyle(pill()).pointerEvents !== "none", "胶囊自身不可 hover（Tooltip 用不了）");
		const below = document.elementFromPoint(
			main.getBoundingClientRect().right - 60,
			pill().getBoundingClientRect().bottom + 6,
		);
		E(below && !stackEl.contains(below), "胶囊下方的空白点击被堆叠吃掉了");
		E(
			document.documentElement.scrollWidth <= document.documentElement.clientWidth,
			"出现了横向滚动：" +
				document.documentElement.scrollWidth +
				" > " +
				document.documentElement.clientWidth,
		);
		step("K 点击穿透与滚动", { below: below?.tagName ?? null });

		const LONG_TOPIC = "a-very-long-channel-topic-name-for-narrow-window-ellipsis-check";

		/**
		 * L 段（窄窗）：由 runner 先打开 CDP 视口仿真（窗口本身有最小宽度，压不到 ~320 的聊天区），
		 * 再调用这里。断言 = 胶囊实际左右边界在聊天区内、宽度不超过可用宽、名字被夹取截断、
		 * glyph 在位且不越界、无横向滚动；Tooltip 的悬停检查由 runner 拿 `hoverPoint` 做。
		 */
		window.__qol3Narrow = async () => {
			try {
				await sleep(400);
				const mainRectNarrow = main.getBoundingClientRect();
				E(mainRectNarrow.width < 360, `聊天区没被压到窄窗量级：${Math.round(mainRectNarrow.width)}`);
				inject([LONG_TOPIC]);
				await sleep(700);
				const narrow = sample();
				const pillRectNarrow = narrow.pillRect;
				E(pillRectNarrow, "窄窗下胶囊没出现");
				E(
					pillRectNarrow.left >= mainRectNarrow.left + 15 &&
						pillRectNarrow.right <= mainRectNarrow.right - 15,
					`窄窗下胶囊越出聊天区：[${Math.round(pillRectNarrow.left)}, ${Math.round(pillRectNarrow.right)}] vs main [${Math.round(mainRectNarrow.left)}, ${Math.round(mainRectNarrow.right)}]`,
				);
				E(
					pillRectNarrow.width <= mainRectNarrow.width - 31,
					`窄窗下胶囊宽 ${Math.round(pillRectNarrow.width)} 超过可用宽 ${Math.round(mainRectNarrow.width - 32)}`,
				);
				// 关键：夹取必须由**可用宽**决定（而不是被 300 设计上限挡住）——名字可见宽要小于 300
				E(
					narrow.nameScroll && narrow.nameScroll.scroll > narrow.nameScroll.client,
					`窄窗下频道名没有被省略：${JSON.stringify(narrow.nameScroll)}`,
				);
				E(
					(narrow.nameScroll?.client ?? 999) < 300,
					`窄窗下名字宽度仍顶到 300 上限（可用宽夹取没生效）：${JSON.stringify(narrow.nameScroll)}`,
				);
				const glyph = pill()?.querySelector("svg");
				E(glyph, "窄窗下胶囊里没有 glyph");
				E(
					Math.round(glyph.getBoundingClientRect().width) === 13,
					`glyph 尺寸异常：${Math.round(glyph.getBoundingClientRect().width)}`,
				);
				E(glyph.getBoundingClientRect().left >= mainRectNarrow.left + 15, "glyph 越出左边界");
				const namesEl = pill()?.querySelector("span.truncate");
				E(namesEl && namesEl.getBoundingClientRect().right <= mainRectNarrow.right - 15, "频道名越出右边界");
				E(
					document.documentElement.scrollWidth <= document.documentElement.clientWidth,
					`窄窗出现横向滚动：${document.documentElement.scrollWidth}`,
				);
				step("L 窄窗夹取与边界", {
					mainWidth: Math.round(mainRectNarrow.width),
					pillWidth: Math.round(pillRectNarrow.width),
					names: narrow.nameScroll,
					glyph: Math.round(glyph.getBoundingClientRect().width),
				});
				R.env.hoverPoint = {
					x: Math.round(pillRectNarrow.left + pillRectNarrow.width / 2),
					y: Math.round(pillRectNarrow.top + pillRectNarrow.height / 2),
				};
				R.env.longTopic = LONG_TOPIC;
			} catch (error) {
				R.failure = String(error?.message ?? error);
				R.failureStack = String(error?.stack ?? "")
					.split("\n")
					.slice(0, 4)
					.join(" | ");
			}
			return R;
		};

		/* ============ M. 切会话：旧名字不得串到新会话 ============ */
		const otherFile = window.__qol3OtherFile;
		E(otherFile, "runner 没给第二个会话文件");
		const switched = await sampleDuring(700, () => {
			void useSessionsStore.getState().openFromHistory(otherFile);
		});
		await sleep(400);
		const newId = active();
		E(newId !== activeId, "没有切到另一个会话");
		inject(["qol3-new-session-topic"], newId);
		await sleep(500);
		// 只统计「切过去之后」的帧：采样从 kick 之前就开始了，那些帧本来就该是旧会话的名字
		const afterSwitch = switched.filter((f) => f.activeId === newId);
		const badFrames = afterSwitch.filter((f) => f.pillText?.includes("a-very-long-channel-topic-name"));
		E(afterSwitch.length > 5, `切会话后采样帧不足（${afterSwitch.length}）`);
		E(badFrames.length === 0, `切会话后仍出现了旧会话的频道名（${badFrames.length} 帧）`);
		E(pill()?.textContent?.includes("qol3-new-session-topic"), `新会话的胶囊没出来：${pill()?.textContent}`);
		step("M 切会话不串名字", { newId, badFrames: badFrames.length });
		R.env.newSessionId = newId;

		/* ============ N. 0 高根后增长（R11 反例）：观察集合要含当前 0 高的根 ============ */
		let growListeners = new Set();
		let growHeight = 0;
		const GrowTodo = () => {
			const [, force] = window.PerchoUI.React.useState(0);
			window.PerchoUI.React.useEffect(() => {
				const fn = () => force((n) => n + 1);
				growListeners.add(fn);
				return () => growListeners.delete(fn);
			}, []);
			return window.PerchoUI.React.createElement("div", {
				"data-probe-todo": "grow",
				className: "absolute top-2 right-4 z-20 rounded-xl bg-surface shadow-pop",
				style: { width: "160px", height: `${growHeight}px` },
			});
		};
		registryMod.useUiPluginRegistry.setState({
			overrides: {
				"chat.todo-panel": { pluginName: "probe-phase4", exportName: "GrowTodo", component: GrowTodo },
			},
		});
		await setTodos(SHORT);
		await sleep(400);
		const growRoot = () => document.querySelector('[data-probe-todo="grow"]');
		E(growRoot(), "0 高根没渲染出来");
		E(growRoot().getBoundingClientRect().height === 0, "该用例前提是根初始高度为 0");
		const stackTopBefore = sample().stackTop;
		E(Math.abs(stackTopBefore - 8) < 1, `0 高根时堆叠该在基准位：${stackTopBefore}`);
		growHeight = 140;
		for (const fn of growListeners) fn();
		await sleep(400);
		const bottomGrown = growRoot().getBoundingClientRect().bottom;
		const stackTopAfter = sample().stackTop;
		E(
			Math.abs(stackTopAfter - (bottomGrown - main.getBoundingClientRect().top + 8)) < 3,
			`0 高根增长后堆叠没跟上（top=${stackTopAfter}，期望 ${bottomGrown - main.getBoundingClientRect().top + 8}）`,
		);
		step("N 0 高根后增长", {
			stackTopBefore,
			stackTopAfter: Math.round(stackTopAfter),
			grownBottom: Math.round(bottomGrown),
		});
		growListeners = new Set();

		/* ---- 收尾：恢复原会话 + 清掉探针注入 ---- */
		registryMod.useUiPluginRegistry.setState({ overrides: {}, contributions: {} });
		uiPluginsMod.useUiPluginsStore.setState((s) => ({ config: { ...s.config, enabled: false } }));
		inject([]);
		await setTodos([]);
		await sleep(500);
		R.env.cleaned = { pill: pill() === null, contrib: contrib() === null };
	} catch (error) {
		R.failure = String(error?.message ?? error);
		R.failureStack = String(error?.stack ?? "")
			.split("\n")
			.slice(0, 4)
			.join(" | ");
	}
	R.env.stackTop = sample().stackTop;
	return R;
}

/* ---------------- CDP 驱动 ---------------- */
function sessionFiles() {
	const root = join(homedir(), ".pi", "agent-dev", "sessions");
	const files = [];
	for (const dir of readdirSync(root, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		for (const name of readdirSync(join(root, dir.name))) {
			if (name.endsWith(".jsonl"))
				files.push({ file: join(root, dir.name, name), mtime: statSync(join(root, dir.name, name)).mtimeMs });
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);
	return files.map((f) => f.file);
}

class Cdp {
	constructor(ws) {
		this.ws = ws;
		this.id = 0;
		this.pending = new Map();
		ws.addEventListener("message", (event) => {
			const msg = JSON.parse(event.data);
			if (msg.id && this.pending.has(msg.id)) {
				const { resolve: done, reject } = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				msg.error ? reject(new Error(JSON.stringify(msg.error))) : done(msg.result);
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
}

const candidates = sessionFiles();
if (candidates.length < 2) {
	console.error("✗ dev agentDir 里的会话文件不足（需要至少两个：当前会话 + 切会话用）");
	process.exit(2);
}
let list;
try {
	list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
} catch {
	console.error(`✗ 连不上 CDP 端口 ${PORT}：dev 是否带 --remote-debugging-port 启动？`);
	process.exit(2);
}
const target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!target) {
	console.error("✗ 没有可调试页面");
	process.exit(2);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((done, fail) => {
	ws.addEventListener("open", done, { once: true });
	ws.addEventListener("error", fail, { once: true });
});
const cdp = new Cdp(ws);
await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Page.reload", { ignoreCache: false });
await new Promise((r) => setTimeout(r, 2500));

const evalIn = async (expression, awaitPromise = false) => {
	const out = await cdp.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
	if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? "页面求值失败");
	return out.result?.value;
};

// 打开一个真实会话（验收需要一个有 transcript 的会话）
await evalIn(
	`(async () => { const s = window.PerchoUI.stores.useSessionsStore; await s.getState().openFromHistory(${JSON.stringify(candidates[0])}); return true; })()`,
	true,
);
await new Promise((r) => setTimeout(r, 1200));

// 注入页面脚本并运行
const source = `window.__qol3OtherFile = ${JSON.stringify(candidates[1])}; window.__qol3ReducedMotion = false; void 0;`;
await evalIn(source);
const result = await evalIn(`(${pageScript.toString()})()`, true);

// reduced-motion 复跑（单独一轮：切换媒体特性 → 重跑脚本里 F 段）
await cdp.send("Emulation.setEmulatedMedia", {
	features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});
const reduced = await evalIn(
	`(async () => { const s = window.PerchoUI.stores.useSessionsStore; await s.getState().openFromHistory(${JSON.stringify(candidates[0])}); window.__qol3ReducedMotion = true; return true; })()`,
	true,
);
await new Promise((r) => setTimeout(r, 1000));
const reducedResult = await evalIn(`(${pageScript.toString()})()`, true);
await cdp.send("Emulation.setEmulatedMedia", { features: [] });

// L 段（窄窗）：窗口有最小宽度 ⇒ 用 CDP 视口仿真把聊天区压到 ~320px，再调页面侧那段专门检查
await cdp.send("Emulation.setDeviceMetricsOverride", {
	width: 560,
	height: 760,
	deviceScaleFactor: 1,
	mobile: false,
});
const narrow = result.failure ? {} : await evalIn("window.__qol3Narrow()", true);
if (narrow?.failure) console.error(`✗ 窄窗段失败：${narrow.failure}`);

// 悬停检查：真实鼠标移到胶囊中心，断言 Tooltip 给出**完整**频道名（R12 要求）
const hoverPoint = narrow?.env?.hoverPoint;
if (hoverPoint && narrow?.env?.longTopic) {
	await cdp.send("Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x: hoverPoint.x,
		y: hoverPoint.y,
		buttons: 0,
	});
	await new Promise((r) => setTimeout(r, 700));
	const tip = await evalIn(`(() => {
		const el = document.querySelector('[role="tooltip"]');
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { text: el.textContent, left: Math.round(r.left), right: Math.round(r.right) };
	})()`);
	console.log(`Tooltip 测量：${JSON.stringify(tip)}`);
	if (!tip || tip.text !== narrow.env.longTopic) {
		console.error(`✗ 窄窗 Tooltip 没给出完整频道名：${JSON.stringify(tip)}`);
		process.exitCode = 1;
	} else if (tip.left < 0) {
		console.error(`✗ Tooltip 向左溢出可见区：${tip.left}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ Tooltip 给出完整频道名且不溢出（left=${tip.left}）`);
	}
}

await cdp.send("Emulation.clearDeviceMetricsOverride");

if (WITH_SHOTS) {
	/**
	 * 截图：窗口被遮挡/合成器空闲时偶发**整帧空白**（见 docs/PITFALLS.md）——纯色 PNG 压缩后极小，
	 * 用体积当判据重试（每次重试先做一次页面侧活动把合成器叫醒）。
	 */
	const captureShot = async (name) => {
		// 纯 rAF 不会产生 damage（合成器可能继续给陈旧/空白表面）——用一颗**屏幕外**的 1×1 块制造一次重绘，
		// 它不可见、且每次重试都会移除，不留痕迹（见 docs/PITFALLS.md 的「整帧空白」条目）
		const nudge = `(() => {
			const el = document.createElement("div");
			el.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;background:#fff";
			document.body.appendChild(el);
			void el.offsetHeight;
			el.remove();
			return document.title;
		})()`;
		let last = 0;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			await evalIn(nudge);
			await new Promise((r) => setTimeout(r, 150 + attempt * 350));
			const shot = await cdp.send("Page.captureScreenshot", { format: "png", scale: 1 });
			const buffer = Buffer.from(shot.data, "base64");
			last = buffer.length;
			if (buffer.length > 60_000) {
				const path = join(SHOT_DIR, name);
				writeFileSync(path, buffer);
				return { path, bytes: buffer.length, attempt: attempt + 1 };
			}
		}
		throw new Error(`截图连续 blank（最后 ${last} 字节）：${name} —— 请确认 dev 窗口未被遮挡/已聚焦后重跑`);
	};

	// ① 真实干净态（注入物已在脚本收尾清掉）
	const clean = await captureShot("qol3-phase4-clean.png");
	// ② 胶囊 + Todo 在场（订阅内容与 todo 是探针注入的合成数据，组件与布局真实）
	await evalIn(
		`(async () => {
			const stores = window.PerchoUI.stores;
			const id = stores.useSessionsStore.getState().activeSessionId;
			const { useChannelSubscriptionsStore } = await import("/src/stores/channel-subscriptions.ts");
			useChannelSubscriptionsStore.getState().apply({
				sessionId: id, live: true, topics: ["qol3-pill-alpha", "channel-subscription-pill"], revision: 9999, generation: 9999,
			});
			stores.useTranscriptStore.getState().loadTodos(id, [
				{ content: "核对频道订阅数据链路", status: "completed" },
				{ content: "接入胶囊与右上堆叠", status: "in_progress" },
				{ content: "真机验收与截图", status: "pending" },
			]);
			stores.useUiStore.setState((s) => ({ todoExpanded: { ...s.todoExpanded, [id]: true } }));
			return true;
		})()`,
		true,
	);
	await new Promise((r) => setTimeout(r, 900));
	const withPill = await captureShot("qol3-phase4-pill.png");
	console.log(`截图：${clean.path}（${clean.bytes} 字节）/ ${withPill.path}（${withPill.bytes} 字节）`);
}

ws.close();
const summary = {
	main: result,
	narrow,
	reducedMotion: reducedResult,
	injected: { otherFile: candidates[1], reducedRan: reduced === true },
};
console.log(JSON.stringify(summary, null, 2));
if (result.failure || reducedResult.failure || narrow?.failure) {
	console.error("✗ 验收失败：", result.failure ?? narrow?.failure ?? reducedResult.failure);
	process.exit(1);
}
console.log("\n✓ 频道胶囊 + 右上堆叠真机验收全部断言通过");
