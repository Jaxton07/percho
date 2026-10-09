#!/usr/bin/env node
/**
 * 历史图片显示成本控制（issue #97 方向 1/2）CDP 脚本
 *
 * 权威文档：.local/agent-work/spec/history-image-performance.md
 *           .local/agent-work/plan/history-image-performance-plan.md
 * 频道：.local/agent-work/channel/history-image-performance/
 *
 * 前置（页面 9224 + 主进程 9229；两个端口都要，主进程侧用于取进程工作集）：
 *   dev：cd packages/desktop && npx electron-vite dev -- --remote-debugging-port=9224 --inspect=9229
 *   build：cd packages/desktop && npm run build && npx electron-vite preview -- --remote-debugging-port=9224 --inspect=9229
 *   （`npm run dev -- --xxx` 不行：npm 会吞参数）
 *
 * 用法：
 *   node scripts/check-history-images.mjs probe      # 阶段 0 技术门：worker 加载策略 × CSP × 格式 × 吞吐（dev 与 build 都要各跑一次）
 *   node scripts/check-history-images.mjs baseline   # 阶段 0 独立对照基线（≥3 轮/场景，冷启动）
 *   通用参数：--rounds=<n>、--scenarios=<key,key>、--out=<file>、--label=<名字>
 *
 * 退出码：0 成功 / 1 断言失败或脚本异常 / 2 环境不满足（连不上 CDP、页面状态不对）
 *
 * 纪律（沿用频道 BASELINE.md 与 issue-97 压力脚本，修正过的记录口径）：
 * - 图片编码（fixture）一律在计时之外、每轮 `Page.reload` 冷启动；
 * - `img.complete && naturalWidth > 0` 记作 **loaded**，不叫 decoded（不证明全尺寸 RGBA 驻留）；
 * - LongTask observer 用完必须 disconnect，否则重复订阅会让条数翻倍；
 * - 滚动锚点验证只看「视口到内容底部的像素距离」（scrollHeight - scrollTop）在上滚时是否单调，
 *   不看 scrollTop 数值（程序性锚定补偿本来就会让 scrollTop 大跳）；
 * - 只读 dev 隔离目录；合成历史只进 renderer 内存，不写盘、不碰正式 `~/.pi/agent`；
 *   临时产物只写 `.local/tmp/history-image-performance/`。
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeAnimatedGifBase64 } from "./fixtures/animated-gif.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP_DIR = join(ROOT, ".local/tmp/history-image-performance");
/** 探针 worker 源码在库里（scripts/fixtures/），不依赖 .local（否则清目录/新 clone 后脚本就废了） */
const PROBE_WORKER_PATH = join(ROOT, "scripts/fixtures/history-image-probe.worker.js");
const OUT_RENDERER_DIR = join(ROOT, "packages/desktop/out/renderer");
const PREVIEW_PROBE_NAME = "__hip-probe.worker.js";
/** 计划采用的加载方式：同源 worker 文件（Vite 打包产物也是同源 URL）。blob 两个策略只是备选探索项 */
const MANDATORY_STRATEGIES = ["same-origin-classic", "same-origin-module"];
const EXPECTED_FIXTURES = [
	"png-2000",
	"png-4k",
	"jpeg-2000",
	"webp-2000",
	"png-transparent",
	"jpeg-exif6",
	"gif-animated",
];

const PAGE_PORT = process.env.CDP_PORT ?? "9224";
const MAIN_PORT = process.env.CDP_MAIN_PORT ?? "9229";
const CALL_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 300_000;

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_ENV = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ CDP */

class Cdp {
	constructor(url, { label, timeoutMs = CALL_TIMEOUT_MS } = {}) {
		this.label = label ?? url;
		this.timeoutMs = timeoutMs;
		this.id = 0;
		this.pending = new Map();
		this.events = [];
		this.ws = new WebSocket(url);
		this.ws.addEventListener("message", (event) => {
			const message = JSON.parse(event.data.toString());
			if (message.id && this.pending.has(message.id)) {
				const entry = this.pending.get(message.id);
				this.pending.delete(message.id);
				clearTimeout(entry.timer);
				if (message.error) entry.reject(new Error(`${this.label} ${JSON.stringify(message.error)}`));
				else entry.resolve(message.result);
				return;
			}
			this.events.push(message);
		});
	}

	ready() {
		if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${this.label} connect timeout`)), 10_000);
			this.ws.addEventListener("open", () => {
				clearTimeout(timer);
				resolve();
			});
			this.ws.addEventListener("error", (event) => {
				clearTimeout(timer);
				reject(new Error(`${this.label} connect error: ${String(event.message ?? event)}`));
			});
		});
	}

	send(method, params = {}, timeoutMs = this.timeoutMs) {
		return new Promise((resolve, reject) => {
			const id = ++this.id;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${this.label} CDP timeout: ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	async eval(expression, timeoutMs = this.timeoutMs) {
		const result = await this.send(
			"Runtime.evaluate",
			{ expression, awaitPromise: true, returnByValue: true },
			timeoutMs,
		);
		if (result.exceptionDetails)
			throw new Error(`${this.label} eval: ${JSON.stringify(result.exceptionDetails)}`);
		return result.result?.value;
	}

	/**
	 * 长调用专用：awaitPromise 的求值结果必须被页面持有，否则 V8 可能在 settle 前回收它，
	 * CDP 回一个 "Promise was collected"（动态 import / 大对象构造时实测会撞上）。
	 */
	call(expression, timeoutMs = this.timeoutMs) {
		return this.eval(`(window.__hipKeep = (async () => (${expression}))())`, timeoutMs);
	}

	/** 轮询求值直到为真；rAF 停摆时不会挂死（页面置为可见 + 纯定时轮询） */
	async waitFor(expression, { timeoutMs = 30_000, intervalMs = 120 } = {}) {
		const deadline = Date.now() + timeoutMs;
		let lastError = null;
		while (Date.now() < deadline) {
			try {
				if (await this.eval(`!!(${expression})`, 5_000)) return true;
			} catch (error) {
				lastError = error;
			}
			await sleep(intervalMs);
		}
		throw new Error(
			`${this.label} waitFor timeout: ${expression}${lastError ? ` (${lastError.message})` : ""}`,
		);
	}

	/** 页面 console / Log 域里与 CSP 相关的条目（worker 或 blob 被拦会落在这里） */
	consoleEntries() {
		const entries = [];
		for (const event of this.events) {
			if (event.method === "Runtime.consoleAPICalled") {
				const text = (event.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
				entries.push({ source: "console", level: event.params.type, text });
			} else if (event.method === "Log.entryAdded") {
				entries.push({
					source: "log",
					level: event.params.entry.level,
					text: event.params.entry.text,
				});
			}
		}
		return entries;
	}

	clearEvents() {
		this.events = [];
	}

	close() {
		try {
			this.ws.close();
		} catch {
			/* 忽略 */
		}
	}
}

async function listTargets(port) {
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	if (!response.ok) throw new Error(`http://127.0.0.1:${port}/json/list → HTTP ${response.status}`);
	return await response.json();
}

async function connectPage() {
	const targets = await listTargets(PAGE_PORT);
	const page = targets.find((target) => target.type === "page" && !target.url.startsWith("devtools://"));
	if (!page) throw new Error(`端口 ${PAGE_PORT} 上没有页面目标`);
	const cdp = new Cdp(page.webSocketDebuggerUrl, { label: "page" });
	await cdp.ready();
	return cdp;
}

/** 主进程侧：取 Electron app.getAppMetrics() 的进程工作集（拿不到就返回 null，不伪造） */
async function connectMain() {
	try {
		const targets = await listTargets(MAIN_PORT);
		if (!targets.length) return null;
		const cdp = new Cdp(targets[0].webSocketDebuggerUrl, { label: "main" });
		await cdp.ready();
		return cdp;
	} catch {
		return null;
	}
}

const MAIN_METRICS_EXPR = `(() => {
	const req = typeof require === "function" ? require : process.mainModule && process.mainModule.require;
	const { app } = req("electron");
	return app.getAppMetrics().map((m) => ({
		pid: m.pid,
		type: m.type,
		rssMb: Math.round(m.memory.workingSetSize / 1024),
		peakRssMb: Math.round((m.memory.peakWorkingSetSize ?? 0) / 1024),
	}));
})()`;

async function readMainMetrics(main) {
	if (!main) return [];
	try {
		return (await main.eval(MAIN_METRICS_EXPR, 10_000)) ?? [];
	} catch {
		return [];
	}
}

/* --------------------------------------------------- 页面助手（注入字符串） */

/**
 * 页面侧助手：CDP 每次 eval 都要跨进程传值，图片 base64 太大不能来回传，
 * 所以 fixture 生成、挂载、探针采样都在页面内完成，只回传小体量的数字与几何。
 * 这里刻意不 import 任何仓库模块（probe 模式要在 build 产物上跑，`/src/...` 不存在）。
 */
const PAGE_HELPERS = String.raw`
window.__hip = (() => {
	const SCROLLER = ".chat-scrollbar";
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const scroller = () => document.querySelector(SCROLLER);
	const median = (values) => {
		if (!values.length) return null;
		const sorted = [...values].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)];
	};
	const state = { frames: [], long: [], marks: [], anchor: null, observer: null, raf: 0, pools: {}, sessionIds: [], rpcSeq: 0 };

	function env() {
		return {
			protocol: location.protocol,
			href: location.href,
			userAgent: navigator.userAgent,
			dpr: devicePixelRatio,
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			hidden: document.hidden,
			hasWorker: typeof Worker === "function",
			hasOffscreenCanvas: typeof OffscreenCanvas === "function",
			hasCreateImageBitmap: typeof createImageBitmap === "function",
			hasImageDecoder: typeof ImageDecoder !== "undefined",
		};
	}

	/* ---------- 采样：帧间隔 + LongTask（用完必须 disconnect） ---------- */
	function startProbe() {
		stopProbe();
		state.frames = [];
		state.long = [];
		state.marks = [];
		let prev = performance.now();
		const tick = (now) => {
			state.frames.push({ time: now, gap: now - prev });
			prev = now;
			state.raf = requestAnimationFrame(tick);
		};
		state.raf = requestAnimationFrame(tick);
		state.observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				state.long.push({ start: entry.startTime, duration: entry.duration });
			}
		});
		state.observer.observe({ type: "longtask", buffered: false });
	}

	function mark(label) {
		state.marks.push({ label, time: performance.now() });
	}

	function stopProbe() {
		if (state.observer) {
			state.observer.disconnect();
			state.observer = null;
		}
		if (state.raf) {
			cancelAnimationFrame(state.raf);
			state.raf = 0;
		}
		const frames = state.frames.slice();
		const long = state.long.slice();
		return {
			maxFrameGapMs: frames.length ? Math.round(Math.max(...frames.map((f) => f.gap)) * 10) / 10 : null,
			frameCount: frames.length,
			longTasks: long.map((l) => ({ start: Math.round(l.start), duration: Math.round(l.duration) })),
			maxLongTaskMs: long.length ? Math.round(Math.max(...long.map((l) => l.duration))) : 0,
			longTaskCount: long.length,
			jsHeapMb: performance.memory
				? Math.round((performance.memory.usedJSHeapSize / 1048576) * 10) / 10
				: null,
			marks: state.marks.slice(),
			// 帧时间戳只用于按打点分段（切会话），不入报告
			frames,
		};
	}

	/* ---------- 几何 / 资源读数 ---------- */
	function metrics() {
		const sc = scroller();
		const imgs = Array.from(document.querySelectorAll(SCROLLER + " img"));
		const loaded = imgs.filter((img) => img.complete && img.naturalWidth > 0);
		return {
			imgCount: imgs.length,
			loadedCount: loaded.length,
			naturalPixels: loaded.reduce((sum, img) => sum + img.naturalWidth * img.naturalHeight, 0),
			maxNaturalSide: loaded.reduce((max, img) => Math.max(max, img.naturalWidth, img.naturalHeight), 0),
			scrollHeight: sc ? sc.scrollHeight : null,
			clientHeight: sc ? sc.clientHeight : null,
			scrollTop: sc ? Math.round(sc.scrollTop) : null,
			tailDistancePx: sc ? Math.round(sc.scrollHeight - sc.scrollTop) : null,
			mountedRows: sc && sc.firstElementChild ? sc.firstElementChild.children.length : 0,
			bodyTextLength: document.body.innerText.trim().length,
			blank: document.body.innerText.trim().length === 0,
			errorBoundary: document.body.innerText.includes("Something went wrong"),
		};
	}

	function imgSrcKinds() {
		const kinds = { data: 0, blob: 0, other: 0, empty: 0, lazyOffscreen: 0 };
		for (const img of document.querySelectorAll(SCROLLER + " img")) {
			const src = img.getAttribute("src") ?? "";
			if (!src) kinds.empty++;
			else if (src.startsWith("data:")) kinds.data++;
			else if (src.startsWith("blob:")) kinds.blob++;
			else kinds.other++;
			const rect = img.getBoundingClientRect();
			const scRect = scroller() ? scroller().getBoundingClientRect() : null;
			if (scRect && (rect.bottom < scRect.top || rect.top > scRect.bottom)) kinds.lazyOffscreen++;
		}
		return kinds;
	}

	function scrollRect() {
		const sc = scroller();
		if (!sc) return null;
		const rect = sc.getBoundingClientRect();
		return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), rect };
	}

	/* ---------- 滚动锚点连续采样（scroll 事件 + rAF 合帧；只取一个时间点会漏掉跳回） ---------- */
	function anchorSample() {
		const sc = scroller();
		if (!sc) return null;
		const rows = sc.firstElementChild ? Array.from(sc.firstElementChild.children) : [];
		const top = sc.getBoundingClientRect().top;
		let index = -1;
		for (let i = 0; i < rows.length; i++) {
			if (rows[i].getBoundingClientRect().bottom > top + 1) {
				index = i;
				break;
			}
		}
		const topmost = index >= 0 ? rows[index] : null;
		const imgs = Array.from(sc.querySelectorAll("img"));
		return {
			time: Math.round(performance.now()),
			scrollTop: Math.round(sc.scrollTop),
			scrollHeight: sc.scrollHeight,
			mountedRows: rows.length,
			topRowIndex: index,
			// 主判据：可见顶行「距尾部行数」。挂载窗口只增不减（只在顶部插入），
			// 故 mountedRows - index 不随“又挂了更多行”而变，等价于全局行号距尾；上滚时必须单调不减。
			topRowDistanceToTail: index >= 0 ? rows.length - index : null,
			topRowText: topmost ? (topmost.innerText || "").replace(/\s+/g, " ").slice(0, 40) : null,
			// 辅助判据（会受下方内容长高影响，不能单独用）
			tailDistancePx: Math.round(sc.scrollHeight - sc.scrollTop),
			imgCount: imgs.length,
			loadedCount: imgs.filter((img) => img.complete && img.naturalWidth > 0).length,
		};
	}

	function startAnchorRecorder() {
		stopAnchorRecorder();
		const sc = scroller();
		if (!sc) return false;
		state.anchor = { samples: [], raf: 0, sc };
		const record = () => {
			const sample = anchorSample();
			if (sample) state.anchor.samples.push(sample);
		};
		state.anchor.record = record;
		state.anchor.onScroll = () => {
			if (state.anchor.raf) return;
			state.anchor.raf = requestAnimationFrame(() => {
				state.anchor.raf = 0;
				record();
			});
		};
		sc.addEventListener("scroll", state.anchor.onScroll, { passive: true });
		record();
		return true;
	}

	function anchorProgress() {
		return anchorSample();
	}

	function stopAnchorRecorder() {
		if (!state.anchor) return [];
		const anchor = state.anchor;
		if (anchor.sc && anchor.onScroll) anchor.sc.removeEventListener("scroll", anchor.onScroll);
		if (anchor.raf) cancelAnimationFrame(anchor.raf);
		const samples = anchor.samples.slice();
		state.anchor = null;
		return samples;
	}

	/* ---------- 合成历史（计时之外生成；每轮冷启动后重建） ---------- */
	const bytesToB64 = (bytes) => {
		let binary = "";
		const CHUNK = 0x8000;
		for (let i = 0; i < bytes.length; i += CHUNK) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
		}
		return btoa(binary);
	};

	function withExifOrientation(jpegBase64, orientation) {
		const binary = atob(jpegBase64);
		const jpeg = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) jpeg[i] = binary.charCodeAt(i);
		if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a jpeg");
		const tiff = [
			0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF LE 头
			0x01, 0x00, // IFD0 条目数
			0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, // Orientation
			0x00, 0x00, 0x00, 0x00, // 下一个 IFD
		];
		const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0"
		const segmentLength = payload.length + 2;
		const app1 = [0xff, 0xe1, (segmentLength >> 8) & 0xff, segmentLength & 0xff, ...payload];
		const out = new Uint8Array(jpeg.length + app1.length);
		out.set(jpeg.subarray(0, 2), 0);
		out.set(app1, 2);
		out.set(jpeg.subarray(2), 2 + app1.length);
		return bytesToB64(out);
	}

	function paintCanvas(width, height, tag, index, transparent) {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (transparent) {
			ctx.clearRect(0, 0, width, height);
			ctx.fillStyle = "rgba(30,90,200,0.65)";
			ctx.beginPath();
			ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.35, 0, Math.PI * 2);
			ctx.fill();
			return canvas;
		}
		ctx.fillStyle = "#f4f4f4";
		ctx.fillRect(0, 0, width, height);
		ctx.fillStyle = "#202020";
		ctx.font = "18px monospace";
		for (let y = 28; y < height; y += 24) {
			ctx.fillText(tag + " #" + index + " y=" + y + " · const render = (history) => history.map(preview);", 20, y);
		}
		ctx.fillStyle = "hsl(" + ((index * 37) % 360) + " 70% 40%)";
		ctx.fillRect((index * 17) % Math.max(1, width - 60), (index * 29) % Math.max(1, height - 60), 60, 40);
		return canvas;
	}

	async function makeFixtures({ pool = "main", kind = "png", count = 0, width = 800, height = 500, tag = "fixture" }) {
		const images = [];
		let base64Chars = 0;
		const started = performance.now();
		for (let i = 0; i < count; i++) {
			const canvas = paintCanvas(width, height, tag, i, kind === "transparent");
			const mime = kind === "jpeg" ? "image/jpeg" : kind === "webp" ? "image/webp" : "image/png";
			const quality = kind === "jpeg" || kind === "webp" ? 0.9 : undefined;
			const data = canvas.toDataURL(mime, quality).split(",")[1];
			base64Chars += data.length;
			images.push({ mimeType: mime, data });
			if (i % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
		}
		state.pools[pool] = images;
		return {
			pool,
			count: images.length,
			width,
			height,
			base64Mb: Math.round((base64Chars / 1048576) * 100) / 100,
			encodeMs: Math.round(performance.now() - started),
		};
	}

	function buildMessages(sessionId, plan, images) {
		const messages = [];
		let cursor = 0;
		let seq = 0;
		for (const block of plan) {
			const take = block.imageCount ?? 0;
			const imgs = images.slice(cursor, cursor + take);
			cursor += take;
			const id = sessionId + "-m" + seq;
			if (block.kind === "user") {
				messages.push({
					id,
					kind: "user",
					text: block.text ?? "截图块 " + seq,
					timestamp: 1700000000000 + seq,
					images: imgs,
				});
			} else {
				messages.push({ id, kind: "image", timestamp: 1700000000000 + seq, images: imgs, paths: [] });
			}
			seq++;
		}
		return messages;
	}

	/** 开始一轮：起采样 → 挂合成历史。图片编码必须在这之前完成（脚本里已如此安排） */
	async function beginRound({ sessionId, plan, pool = "main", keepProbe = false, phaseLabel = "phase:mount:start" }) {
		// keepProbe：切会话样本要在同一条采样时间轴上比对「加载 A / 加载 B / 反复切换」，
		// 第二次 beginRound 不能再 startProbe（那会清掉前面的帧与打点）
		if (!keepProbe) startProbe();
		mark(phaseLabel);
		const images = state.pools[pool] ?? [];
		const messages = buildMessages(sessionId, plan, images);
		const { useSessionsStore } = await import("/src/stores/sessions.ts");
		const { useTranscriptStore } = await import("/src/stores/transcript.ts");
		useTranscriptStore.getState().loadHistory(sessionId, messages);
		useSessionsStore.setState({ activeSessionId: sessionId });
		state.sessionIds.push(sessionId);
		mark("mount:" + sessionId);
		return { messages: messages.length, images: messages.reduce((n, m) => n + m.images.length, 0) };
	}

	/** 反复置顶触发向上补挂（程序性赋值只用于「把行挂出来」，不当滚动验证手段） */
	async function scrollUpAll({ steps = 10, stepMs = 300 } = {}) {
		const sc = scroller();
		if (!sc) return 0;
		let done = 0;
		for (let i = 0; i < steps; i++) {
			sc.scrollTop = 0;
			sc.dispatchEvent(new Event("scroll", { bubbles: true }));
			done++;
			await sleep(stepMs);
		}
		return done;
	}

	/** 快速切会话：切一次 → 停一会 → 打点，帧间隔按点分段 */
	async function switchMeasure({ ids, times = 6, holdMs = 800 }) {
		if (!ids.length) return [];
		const { useSessionsStore } = await import("/src/stores/sessions.ts");
		mark("switch:start");
		for (let i = 0; i < times; i++) {
			mark("switch:begin");
			useSessionsStore.setState({ activeSessionId: ids[i % ids.length] });
			await sleep(holdMs);
			mark("switch:end:" + ids[i % ids.length]);
		}
		return state.marks.slice();
	}

	async function resetAll() {
		return await clearSessions();
	}

	/** 把 renderer 里已装载的会话（含启动恢复链打开的真实会话）清出去，让每轮从零开始 */
	async function clearSessions() {
		const { useSessionsStore } = await import("/src/stores/sessions.ts");
		const { useTranscriptStore } = await import("/src/stores/transcript.ts");
		const ids = Object.keys(useTranscriptStore.getState().bySession);
		for (const id of ids) useTranscriptStore.getState().resetSession(id);
		useSessionsStore.setState({ activeSessionId: null });
		state.sessionIds = [];
		state.pools = {};
		return ids;
	}

	/* ---------- worker 技术探针 ---------- */
	function createWorker(strategy, blobSource) {
		if (!strategy.url) {
			const url = URL.createObjectURL(new Blob([blobSource], { type: "text/javascript" }));
			const worker = new Worker(url, strategy.type ? { type: strategy.type } : undefined);
			worker.__hipBlobUrl = url;
			return worker;
		}
		return new Worker(strategy.url, strategy.type ? { type: strategy.type } : undefined);
	}

	function rpc(worker, op, payload, timeoutMs) {
		return new Promise((resolve, reject) => {
			const id = ++state.rpcSeq;
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("worker rpc timeout: " + op));
			}, timeoutMs ?? 30000);
			function cleanup() {
				clearTimeout(timer);
				worker.removeEventListener("message", onMessage);
				worker.removeEventListener("error", onError);
			}
			function onMessage(event) {
				const data = event.data ?? {};
				if (data.id !== id) return;
				cleanup();
				if (data.ok) resolve(data);
				else reject(new Error(String(data.error)));
			}
			function onError(event) {
				cleanup();
				reject(new Error("worker error: " + String(event.message ?? "unknown")));
			}
			worker.addEventListener("message", onMessage);
			worker.addEventListener("error", onError);
			worker.postMessage({ id, op, ...payload });
		});
	}

	/** 探针用格式样本：PNG / JPEG / WebP / 透明 PNG / EXIF-6 JPEG / 动画 GIF / 4K PNG */
	async function probeFixtures(gifBase64) {
		const shot = paintCanvas(2000, 1250, "probe", 3, false);
		const png2000 = shot.toDataURL("image/png").split(",")[1];
		const big = paintCanvas(3840, 2160, "probe4k", 7, false);
		const png4k = big.toDataURL("image/png").split(",")[1];
		const jpeg = shot.toDataURL("image/jpeg", 0.9).split(",")[1];
		const webp = shot.toDataURL("image/webp", 0.9).split(",")[1];
		const transparent = paintCanvas(600, 400, "alpha", 1, true).toDataURL("image/png").split(",")[1];
		return [
			{ name: "png-2000", mimeType: "image/png", base64: png2000 },
			{ name: "png-4k", mimeType: "image/png", base64: png4k },
			{ name: "jpeg-2000", mimeType: "image/jpeg", base64: jpeg },
			{ name: "webp-2000", mimeType: "image/webp", base64: webp },
			{ name: "png-transparent", mimeType: "image/png", base64: transparent },
			{ name: "jpeg-exif6", mimeType: "image/jpeg", base64: withExifOrientation(jpeg, 6) },
			{ name: "gif-animated", mimeType: "image/gif", base64: gifBase64 },
		];
	}

	const stripBlob = (result) => {
		if (!result) return result;
		const { blob, ...rest } = result;
		return rest;
	};

	async function blobUrlImgCheck(thumbnail) {
		if (!thumbnail || !thumbnail.blob) return { ok: false, error: "no thumbnail blob" };
		const url = URL.createObjectURL(thumbnail.blob);
		try {
			const img = new Image();
			const outcome = await new Promise((resolve) => {
				const timer = setTimeout(() => resolve({ loaded: false, timeout: true }), 5000);
				img.onload = () => {
					clearTimeout(timer);
					resolve({ loaded: true, width: img.naturalWidth, height: img.naturalHeight });
				};
				img.onerror = () => {
					clearTimeout(timer);
					resolve({ loaded: false });
				};
				img.src = url;
			});
			return { urlScheme: url.split(":")[0] + ":", ...outcome };
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	async function benchThumbs(worker, fixtures) {
		const run = async (fixture, count, maxSide) => {
			const times = [];
			for (let i = 0; i < count; i++) {
				const started = performance.now();
				try {
					await rpc(worker, "thumb", { base64: fixture.base64, mimeType: fixture.mimeType, maxSide }, 60000);
				} catch (error) {
					return { count: times.length, error: String(error), times };
				}
				times.push(Math.round(performance.now() - started));
			}
			return {
				count: times.length,
				firstMs: times[0] ?? null,
				medianMs: median(times),
				maxMs: times.length ? Math.max(...times) : null,
				times,
			};
		};
		return {
			thumb2000: await run(fixtures.find((f) => f.name === "png-2000"), 8, 384),
			thumb4k: await run(fixtures.find((f) => f.name === "png-4k"), 8, 384),
		};
	}

	async function workerProbe({ strategies, bench = true }) {
		const blobSource = window.__hipBlobSource;
		const report = { strategies: [], blobImgCheck: null, fixtureSummary: null };
		let fixtures;
		try {
			fixtures = await probeFixtures(window.__hipGifBase64 ?? "");
			report.fixtureSummary = fixtures.map((f) => ({
				name: f.name,
				mimeType: f.mimeType,
				base64Chars: f.base64.length,
			}));
		} catch (error) {
			report.fixtureError = String(error);
			return report;
		}
		for (const strategy of strategies) {
			const entry = { name: strategy.name, type: strategy.type ?? "classic", url: strategy.url ? "same-origin" : "blob" };
			let worker = null;
			try {
				worker = createWorker(strategy, blobSource);
				entry.echo = (await rpc(worker, "echo", {}, 15000)).echo;
				entry.thumbnails = [];
				for (const fixture of fixtures) {
					if (!fixture.base64) {
						entry.thumbnails.push({ name: fixture.name, ok: false, error: "fixture 缺失" });
						continue;
					}
					try {
						const response = await rpc(
							worker,
							"thumb",
							{ base64: fixture.base64, mimeType: fixture.mimeType, maxSide: 384 },
							60000,
						);
						entry.thumbnails.push({ name: fixture.name, ok: true, ...stripBlob(response.result) });
						if (!report.blobImgCheck && response.result?.blob) {
							report.blobImgCheck = await blobUrlImgCheck(response.result);
						}
					} catch (error) {
						entry.thumbnails.push({ name: fixture.name, ok: false, error: String(error) });
					}
				}
				try {
					const response = await rpc(
						worker,
						"thumb",
						{
							base64: fixtures[1].base64,
							mimeType: fixtures[1].mimeType,
							resizeTo: { width: 384, height: 216 },
						},
						60000,
					);
					entry.resizeOption = stripBlob(response.result);
				} catch (error) {
					entry.resizeOption = { ok: false, error: String(error) };
				}
				try {
					// EXIF Orientation=6：不传 imageOrientation（浏览器默认）时是否同样自动摆正
					const exif = fixtures.find((f) => f.name === "jpeg-exif6");
					const response = await rpc(
						worker,
						"thumb",
						{ base64: exif.base64, mimeType: exif.mimeType, maxSide: 384, imageOrientation: null },
						60000,
					);
					entry.exifDefaultOrientation = stripBlob(response.result);
				} catch (error) {
					entry.exifDefaultOrientation = { ok: false, error: String(error) };
				}
				try {
					const response = await rpc(worker, "gifinfo", { base64: window.__hipGifBase64 ?? "" }, 30000);
					entry.gif = response.result;
				} catch (error) {
					entry.gif = { ok: false, error: String(error) };
				}
				if (bench) entry.bench = await benchThumbs(worker, fixtures);
			} catch (error) {
				entry.error = String(error);
			} finally {
				if (worker) {
					const blobUrl = worker.__hipBlobUrl;
					worker.terminate();
					if (blobUrl) URL.revokeObjectURL(blobUrl);
				}
			}
			report.strategies.push(entry);
		}
		return report;
	}

	return {
		env,
		startProbe,
		stopProbe,
		mark,
		metrics,
		imgSrcKinds,
		scrollRect,
		startAnchorRecorder,
		anchorProgress,
		stopAnchorRecorder,
		makeFixtures,
		beginRound,
		scrollUpAll,
		switchMeasure,
		resetAll,
		clearSessions,
		workerProbe,
	};
})();
true;
`;

/* --------------------------------------------------------------- 公共动作 */

async function installHelpers(page) {
	await page.eval(PAGE_HELPERS);
}

async function installGifFixture(page) {
	// 夹具是脚本内生成的（scripts/fixtures/animated-gif.mjs），不依赖任何依赖包里的图片；
	// 它到底是不是动画，由探针的 ImageDecoder frameCount 断言自己证明。
	const gif = Buffer.from(makeAnimatedGifBase64(), "base64");
	await page.eval(`window.__hipGifBase64 = ${JSON.stringify(gif.toString("base64"))}; true`);
	return gif.length;
}

async function setViewport(page, width, height) {
	await page.eval(`(() => { window.resizeTo(${width}, ${height}); return true; })()`);
	// macOS 会按工作区夹紧尺寸，且窗口尺寸/DPR 在 resize 后有一小段过渡帧：
	// 必须等**连续两次读数相同**才当稳定的验收视口（否则会拿到过渡态的 dpr=1）
	await sleep(800);
	let previous = null;
	for (let i = 0; i < 20; i++) {
		const size = await page.eval("({ w: window.innerWidth, h: window.innerHeight, dpr: devicePixelRatio })");
		if (previous && previous.w === size.w && previous.h === size.h && previous.dpr === size.dpr) {
			return { ...size, requested: { width, height }, mismatched: size.w !== width || size.h !== height };
		}
		previous = size;
		await sleep(200);
	}
	return { ...previous, requested: { width, height }, mismatched: true };
}

async function reloadApp(page) {
	await page.send("Page.reload", { ignoreCache: true });
	await page.waitFor("document.getElementById('splash') === null", { timeoutMs: 30_000 });
	// 重启后落在新会话页（没有 .chat-scrollbar）；这里只等应用外壳就绪，聊天容器由 beginRound 建
	await page.waitFor(
		"document.getElementById('root') && document.getElementById('root').childElementCount > 0",
		{
			timeoutMs: 30_000,
		},
	);
	// 启动恢复链（工作区快照 → 打开上次会话）是异步的，等它跑完再清，避免它抢 activeSessionId
	await sleep(1500);
	await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
	await installHelpers(page);
}

function startMemoryPoll(main, intervalMs = 250) {
	const peak = new Map();
	let running = true;
	const task = (async () => {
		while (running) {
			for (const metric of await readMainMetrics(main)) {
				const previous = peak.get(metric.pid);
				peak.set(metric.pid, {
					...metric,
					rssMb: Math.max(metric.rssMb, previous?.rssMb ?? 0),
				});
			}
			await sleep(intervalMs);
		}
	})();
	return {
		intervalMs,
		stop: async () => {
			running = false;
			await task;
			return Array.from(peak.values()).sort((a, b) => b.rssMb - a.rssMb);
		},
	};
}

function cspViolations(entries) {
	const pattern = /Content Security Policy|Refused to (load|create|execute|connect|apply)/i;
	return entries.filter((entry) => pattern.test(entry.text));
}

/* ------------------------------------------------------------------ probe */

/**
 * 技术门断言：纯函数（报告 + console 条目 → 检查项），既用于正式判定，也被自检喂变异报告。
 * mandatory 才会否门；informational 只记录——不采用的备选策略失败不该否掉整个门。
 */
function evaluateProbeReport(report, consoleEntries, { sentinel }) {
	const checks = [];
	const add = (id, level, ok, detail) => {
		checks.push({ id, level, ok: Boolean(ok), detail: detail === undefined ? null : detail });
	};
	const byName = new Map((report.strategies ?? []).map((strategy) => [strategy.name, strategy]));

	// 「0 违规」只有在**捕获本身可信**时才算证据：先看哨兵有没有抓到已知违规
	add("csp:capture-live", "mandatory", sentinel?.detected === true, sentinel?.samples ?? []);
	const violations = cspViolations(consoleEntries);
	add(
		"csp:no-violation",
		"mandatory",
		violations.length === 0,
		violations.slice(0, 3).map((v) => v.text.slice(0, 160)),
	);

	for (const name of MANDATORY_STRATEGIES) {
		const strategy = byName.get(name);
		if (!strategy) {
			add(`strategy:${name}:exists`, "mandatory", false, "报告里没有这个策略");
			continue;
		}
		add(
			`strategy:${name}:worker`,
			"mandatory",
			strategy.echo?.scope === "worker",
			strategy.error ?? strategy.echo ?? "没有 echo",
		);
		const thumbnails = new Map((strategy.thumbnails ?? []).map((thumbnail) => [thumbnail.name, thumbnail]));
		const missing = EXPECTED_FIXTURES.filter((fixture) => !thumbnails.has(fixture));
		add(`strategy:${name}:fixtures`, "mandatory", missing.length === 0, missing);
		const broken = [...thumbnails.values()].filter((thumbnail) => !thumbnail.ok);
		add(
			`strategy:${name}:thumbnails-ok`,
			"mandatory",
			broken.length === 0,
			broken.map((thumbnail) => `${thumbnail.name}: ${thumbnail.error}`),
		);
		const oversized = [...thumbnails.values()].filter(
			(thumbnail) => thumbnail.ok && Math.max(thumbnail.width, thumbnail.height) > 384,
		);
		add(
			`strategy:${name}:max-side`,
			"mandatory",
			oversized.length === 0,
			oversized.map((thumbnail) => `${thumbnail.name} ${thumbnail.width}×${thumbnail.height}`),
		);
		const badBlobs = [...thumbnails.values()].filter(
			(thumbnail) => thumbnail.ok && (thumbnail.blobType !== "image/png" || !(thumbnail.blobBytes > 0)),
		);
		add(
			`strategy:${name}:blob`,
			"mandatory",
			badBlobs.length === 0,
			badBlobs.map((thumbnail) => `${thumbnail.name} ${thumbnail.blobType}/${thumbnail.blobBytes}`),
		);
		const transparent = thumbnails.get("png-transparent");
		add(
			`strategy:${name}:alpha`,
			"mandatory",
			transparent?.minAlpha < 255,
			`minAlpha=${transparent?.minAlpha}`,
		);
		const lostAlpha = [...thumbnails.values()].filter(
			(thumbnail) => thumbnail.ok && thumbnail.name !== "png-transparent" && thumbnail.minAlpha !== 255,
		);
		add(
			`strategy:${name}:opaque-alpha`,
			"mandatory",
			lostAlpha.length === 0,
			lostAlpha.map((thumbnail) => `${thumbnail.name} minAlpha=${thumbnail.minAlpha}`),
		);
		const exif = thumbnails.get("jpeg-exif6");
		add(
			`strategy:${name}:exif`,
			"mandatory",
			exif?.srcWidth === 1250 && exif?.srcHeight === 2000 && exif?.width < exif?.height,
			`源 ${exif?.srcWidth}×${exif?.srcHeight} → ${exif?.width}×${exif?.height}`,
		);
		add(
			`strategy:${name}:exif-default`,
			"mandatory",
			strategy.exifDefaultOrientation?.srcWidth === 1250 &&
				strategy.exifDefaultOrientation?.srcHeight === 2000,
			strategy.exifDefaultOrientation,
		);
		add(
			`strategy:${name}:gif`,
			"mandatory",
			strategy.gif?.frameCount > 1 &&
				strategy.gif?.bitmapWidth === strategy.gif?.firstFrameWidth &&
				strategy.gif?.bitmapHeight === strategy.gif?.firstFrameHeight,
			strategy.gif,
		);
		add(
			`strategy:${name}:blob-url-img`,
			"mandatory",
			report.blobImgCheck?.loaded === true,
			report.blobImgCheck,
		);
	}

	for (const strategy of report.strategies ?? []) {
		if (MANDATORY_STRATEGIES.includes(strategy.name)) continue;
		add(
			`strategy:${strategy.name}`,
			"informational",
			Boolean(strategy.echo) && (strategy.thumbnails ?? []).every((thumbnail) => thumbnail.ok),
			strategy.echo ? null : (strategy.error ?? strategy.constructError),
		);
	}
	if (report.strategies?.[0]?.resizeOption) {
		add(
			"resize-option",
			"informational",
			report.strategies[0].resizeOption.ok === true,
			report.strategies[0].resizeOption,
		);
	}

	return { checks, failures: checks.filter((check) => check.level === "mandatory" && !check.ok) };
}

/**
 * 自检用的「全绿」报告样本：形状与 workerProbe 产物一致，字段取一份合法值。
 * 自检要验的是「门能不能挡住失败」，所以基线必须本身全绿——不能拿真实报告当基线，
 * 否则真实报告一旦有 mandatory 失败，「只备选失败不否门」这条就没法验了。
 */
function makeGoodProbeReport() {
	const base = (name, url, type) => {
		const thumbnails = EXPECTED_FIXTURES.map((fixture) => ({
			name: fixture,
			ok: true,
			via: "canvas-draw",
			srcWidth: 2000,
			srcHeight: 1250,
			width: 384,
			height: 240,
			blobBytes: 50_000,
			blobType: "image/png",
			minAlpha: 255,
			ms: { total: 16, base64: 2, decode: 10, draw: 2, encode: 5 },
		}));
		const exif = thumbnails.find((fixture) => fixture.name === "jpeg-exif6");
		Object.assign(exif, { srcWidth: 1250, srcHeight: 2000, width: 240, height: 384 });
		thumbnails.find((fixture) => fixture.name === "png-transparent").minAlpha = 0;
		return {
			name,
			url,
			type,
			echo: { scope: "worker", hasCreateImageBitmap: true, hasOffscreenCanvas: true },
			thumbnails,
			exifDefaultOrientation: { ok: true, srcWidth: 1250, srcHeight: 2000 },
			gif: {
				frameCount: 2,
				animated: true,
				bitmapWidth: 4,
				bitmapHeight: 4,
				firstFrameWidth: 4,
				firstFrameHeight: 4,
			},
			resizeOption: { ok: true, via: "bitmap-resize-option" },
		};
	};
	return {
		strategies: [
			base("same-origin-classic", "same-origin", "classic"),
			base("same-origin-module", "same-origin", "module"),
			base("blob-classic", "blob", "classic"),
			base("blob-module", "blob", "module"),
		],
		blobImgCheck: { loaded: true, width: 384, height: 240 },
		fixtureSummary: [],
	};
}

/**
 * 门自检：把「全绿样本」按已知失败模式变异，确认 evaluateProbeReport 真的会红灯。
 * 断言写了不等于它会挡住失败——这一层保证门本身没瞎。
 */
function selfTestProbeGate() {
	const cases = [];
	const mutate = (fn) => {
		const report = JSON.parse(JSON.stringify(makeGoodProbeReport()));
		const entries = [];
		fn(report, entries);
		return evaluateProbeReport(report, entries, { sentinel: { detected: true } }).failures.map(
			(failure) => failure.id,
		);
	};
	const check = (name, expectFail, failures) => {
		const caught = failures.length > 0;
		cases.push({ name, expectFail, caught, ok: caught === expectFail, failures: failures.slice(0, 4) });
	};
	const mandatory = (report) =>
		report.strategies.find((strategy) => strategy.name === MANDATORY_STRATEGIES[0]);
	const thumbnail = (report, name) => mandatory(report).thumbnails.find((item) => item.name === name);

	check(
		"基线样本本身全绿（否则自检没意义）",
		false,
		mutate(() => {}),
	);
	check(
		"主策略 worker 起不来",
		true,
		mutate((report) => {
			mandatory(report).echo = null;
			mandatory(report).error = "synthetic";
		}),
	);
	check(
		"某格式缩图失败",
		true,
		mutate((report) => {
			thumbnail(report, "webp-2000").ok = false;
		}),
	);
	check(
		"缩图超 384",
		true,
		mutate((report) => {
			thumbnail(report, "png-2000").width = 512;
		}),
	);
	check(
		"漏一个格式样本",
		true,
		mutate((report) => {
			mandatory(report).thumbnails = mandatory(report).thumbnails.filter((item) => item.name !== "webp-2000");
		}),
	);
	check(
		"Blob URL img 未加载",
		true,
		mutate((report) => {
			report.blobImgCheck.loaded = false;
		}),
	);
	check(
		"EXIF 未摆正",
		true,
		mutate((report) => {
			const exif = thumbnail(report, "jpeg-exif6");
			exif.srcWidth = 2000;
			exif.srcHeight = 1250;
		}),
	);
	check(
		"透明 alpha 丢失",
		true,
		mutate((report) => {
			thumbnail(report, "png-transparent").minAlpha = 255;
		}),
	);
	check(
		"GIF 退化成单帧",
		true,
		mutate((report) => {
			mandatory(report).gif.frameCount = 1;
		}),
	);
	check(
		"注入一条 CSP 违规",
		true,
		mutate((_report, entries) => {
			entries.push({
				source: "log",
				level: "error",
				text: "Refused to load the image 'blob:x' because it violates the following Content Security Policy directive: \"img-src 'self' data: pi-bg:\".",
			});
		}),
	);
	check(
		"仅备选(blob)策略失败不否门",
		false,
		mutate((report) => {
			for (const strategy of report.strategies.filter((item) => !MANDATORY_STRATEGIES.includes(item.name))) {
				strategy.echo = null;
				strategy.error = "synthetic";
			}
		}),
	);
	check(
		"CSP 哨兵失效（捕获不可信）",
		true,
		evaluateProbeReport(makeGoodProbeReport(), [], {
			sentinel: { detected: false, samples: [] },
		}).failures.map((failure) => failure.id),
	);

	return { cases, failed: cases.filter((item) => !item.ok) };
}

/**
 * CSP 捕获自检哨兵：发一个已知会被 CSP 拦掉的跨源请求，确认 Log/Runtime 真能收到违规条目。
 * 跑完清空事件，所以这条哨兵不计入正式探针的违规统计。
 */
async function runCspSentinel(page) {
	page.clearEvents();
	await page.eval(`(() => { fetch("https://csp-sentinel.invalid/probe").catch(() => {}); return true; })()`);
	await sleep(700);
	const hits = cspViolations(page.consoleEntries());
	return { detected: hits.length > 0, samples: hits.slice(0, 3).map((hit) => hit.text.slice(0, 200)) };
}

async function runProbe(page, opts) {
	// 每次探针都冷启动：CSP / worker 加载都是「页面文档级」事实，不能拿上一次导航的旧文档当证据
	await reloadApp(page);
	const env = await page.call("window.__hip.env()");
	const isPreview = env.protocol === "file:";
	let sameOriginUrl = null;
	if (isPreview) {
		await copyFile(PROBE_WORKER_PATH, join(OUT_RENDERER_DIR, PREVIEW_PROBE_NAME));
		sameOriginUrl = `./${PREVIEW_PROBE_NAME}`;
	} else {
		sameOriginUrl = `/@fs${PROBE_WORKER_PATH}`;
	}
	const blobSource = await readFile(PROBE_WORKER_PATH, "utf8");
	await page.eval(`window.__hipBlobSource = ${JSON.stringify(blobSource)}; true`);

	const strategies = [
		{ name: "same-origin-classic", url: sameOriginUrl },
		{ name: "same-origin-module", url: sameOriginUrl, type: "module" },
		{ name: "blob-classic" },
		{ name: "blob-module", type: "module" },
	];

	const started = Date.now();
	let sentinel = null;
	let gifBytes = 0;
	let report = null;
	let consoleEntries = [];
	let evaluation = { checks: [], failures: [] };
	let selfTest = { cases: [], failed: [] };
	try {
		sentinel = await runCspSentinel(page);
		page.clearEvents();
		gifBytes = await installGifFixture(page);
		report = await page.call(
			`window.__hip.workerProbe(${JSON.stringify({ strategies, bench: true })})`,
			LONG_TIMEOUT_MS,
		);
		consoleEntries = page.consoleEntries();
		evaluation = evaluateProbeReport(report, consoleEntries, { sentinel });
		selfTest = selfTestProbeGate();
	} finally {
		// 探针 worker 是临时拷进产物目录的，别让它有留在包里的机会
		if (isPreview) await rm(join(OUT_RENDERER_DIR, PREVIEW_PROBE_NAME), { force: true });
	}

	const summary = {
		mode: "probe",
		label: opts.label ?? null,
		runtime: isPreview ? "build-preview" : "dev",
		startedAt: new Date(started).toISOString(),
		elapsedMs: Date.now() - started,
		env,
		probeWorker: PROBE_WORKER_PATH,
		sameOriginUrl,
		gifFixtureBytes: gifBytes,
		sentinel,
		report,
		checks: evaluation.checks,
		failures: evaluation.failures,
		selfTest,
		cspViolations: cspViolations(consoleEntries),
		consoleCount: consoleEntries.length,
		consoleSample: consoleEntries.slice(0, 40),
	};

	console.log(`\n== probe（${summary.runtime}）==`);
	console.log(`URL：${env.href}`);
	console.log(`UA：${env.userAgent}`);
	for (const strategy of report.strategies) {
		const okThumbs = (strategy.thumbnails ?? []).filter((thumbnail) => thumbnail.ok).length;
		console.log(
			[
				`- ${strategy.name} [${strategy.type}/${strategy.url}]`,
				strategy.echo ? "worker OK" : `FAILED: ${strategy.error ?? strategy.constructError}`,
				strategy.echo ? `缩图 ${okThumbs}/${(strategy.thumbnails ?? []).length}` : "",
				strategy.bench
					? `bench 2000: ${strategy.bench.thumb2000?.medianMs}ms(首 ${strategy.bench.thumb2000?.firstMs}ms) · 4k: ${strategy.bench.thumb4k?.medianMs}ms(首 ${strategy.bench.thumb4k?.firstMs}ms)`
					: "",
			]
				.filter(Boolean)
				.join(" · "),
		);
	}
	for (const thumbnail of report.strategies[0]?.thumbnails ?? []) {
		console.log(
			`    ${thumbnail.name}: ${
				thumbnail.ok
					? `${thumbnail.srcWidth}×${thumbnail.srcHeight} → ${thumbnail.width}×${thumbnail.height} / ${thumbnail.blobBytes}B · minAlpha=${thumbnail.minAlpha} · ${Math.round(thumbnail.ms.total)}ms (${thumbnail.via})`
					: `失败 ${thumbnail.error}`
			}`,
		);
	}
	if (report.strategies[0]?.resizeOption) {
		console.log(`createImageBitmap resize 选项：${JSON.stringify(report.strategies[0].resizeOption)}`);
	}
	console.log(`EXIF 默认方向：${JSON.stringify(report.strategies[0]?.exifDefaultOrientation)}`);
	console.log(`blob: URL img：${JSON.stringify(report.blobImgCheck)}`);
	console.log(`GIF：${JSON.stringify(report.strategies[0]?.gif)}`);
	console.log(`CSP 哨兵：${JSON.stringify(sentinel)}`);
	console.log(`CSP 正式违规条目：${summary.cspViolations.length}`);

	console.log("\n门断言：");
	for (const check of evaluation.checks) {
		console.log(
			`  ${check.ok ? "PASS" : "FAIL"} [${check.level}] ${check.id}${check.ok ? "" : ` → ${JSON.stringify(check.detail)}`}`,
		);
	}
	console.log(
		`自检（门能不能挡住失败）：${selfTest.cases.filter((item) => item.ok).length}/${selfTest.cases.length}`,
	);
	for (const item of selfTest.cases) {
		console.log(
			`  ${item.ok ? "PASS" : "FAIL"} ${item.name}（期望${item.expectFail ? "失败" : "通过"}）${item.ok ? "" : ` → ${JSON.stringify(item.failures)}`}`,
		);
	}

	let exitCode = EXIT_OK;
	if (evaluation.failures.length > 0) {
		console.error(`\n[FAIL] 技术门未过：${evaluation.failures.map((failure) => failure.id).join(", ")}`);
		exitCode = EXIT_FAIL;
	}
	if (selfTest.failed.length > 0) {
		console.error(`\n[FAIL] 门自检未过：${selfTest.failed.map((item) => item.name).join(", ")}`);
		exitCode = EXIT_FAIL;
	}
	return { summary, exitCode };
}

/* --------------------------------------------------------------- baseline */

const BASELINE_SCENARIOS = [
	{ key: "none", kind: "text", count: 0, width: 0, height: 0, blocks: 20, label: "无图对照（20 条文本）" },
	{ key: "user-40-2000", kind: "user", count: 40, width: 2000, height: 1250, label: "用户附件 40×2000" },
	{
		key: "user-120-2000",
		kind: "user",
		count: 120,
		width: 2000,
		height: 1250,
		expectsExpansion: true,
		label: "用户附件 120×2000",
	},
	{ key: "show-40-2000", kind: "image", count: 40, width: 2000, height: 1250, label: "show_image 40×2000" },
	{
		key: "show-120-2000",
		kind: "image",
		count: 120,
		width: 2000,
		height: 1250,
		label: "show_image 120×2000",
	},
	{ key: "show-40-4k", kind: "image", count: 40, width: 3840, height: 2160, label: "show_image 40×4K" },
	{
		key: "show-120-4k",
		kind: "image",
		count: 120,
		width: 3840,
		height: 2160,
		expectsExpansion: true,
		label: "show_image 120×4K",
	},
	{
		key: "single-9img",
		kind: "image",
		count: 9,
		width: 2000,
		height: 1250,
		label: "单条 show_image 9 图（多图分档）",
		plan: [{ kind: "image", imageCount: 9 }],
	},
	{
		key: "mixed",
		kind: "mixed",
		count: 22,
		width: 3840,
		height: 2160,
		label: "混合：用户 3 图 + show 1/6/9 + 用户 1/2 图",
		plan: [
			{ kind: "user", imageCount: 3 },
			{ kind: "image", imageCount: 1 },
			{ kind: "image", imageCount: 6 },
			{ kind: "user", imageCount: 1 },
			{ kind: "image", imageCount: 9 },
			{ kind: "user", imageCount: 2 },
		],
	},
	{
		key: "switch",
		kind: "switch",
		count: 40,
		width: 3840,
		height: 2160,
		label: "快速切会话：40×4K show_image ↔ 40×2000 用户图",
	},
];

function planForScenario(scenario) {
	if (scenario.plan) return scenario.plan;
	if (scenario.key === "none") {
		return Array.from({ length: scenario.blocks ?? 20 }, () => ({ kind: "user", imageCount: 0 }));
	}
	return Array.from({ length: scenario.count }, () => ({ kind: scenario.kind, imageCount: 1 }));
}

const VIEWPORT = { width: 1400, height: 860 };

/**
 * 真实滚轮 + 向上补挂：CSD 发真实 wheel 事件，一直滚到「至少发生 N 次新挂载」且接近顶部。
 * 锚点采样在**页面里连续进行**（scroll 事件 + rAF 合帧），这里只负责发轮事件与收样本——
 * 每步只在一个时刻取一个点会漏掉中途跳回，那正是要抓的东西。
 */
async function wheelExpandProbe(page, { requireGrowth = 0, maxSteps = 240, stepMs = 100 } = {}) {
	const rect = await page.call("window.__hip.scrollRect()");
	if (!rect) return { error: "找不到 .chat-scrollbar" };
	if (!(await page.call("window.__hip.startAnchorRecorder()"))) return { error: "锚点采样器起不来" };
	const first = await page.call("window.__hip.anchorProgress()");
	let growth = 0;
	let previousRows = first?.mountedRows ?? 0;
	let steps = 0;
	let sinceGrowth = 0;
	let last = first;
	for (steps = 1; steps <= maxSteps; steps++) {
		await page.send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: rect.x,
			y: rect.y,
			deltaX: 0,
			deltaY: -120,
			modifiers: 0,
		});
		await sleep(stepMs);
		last = await page.call("window.__hip.anchorProgress()");
		if ((last?.mountedRows ?? 0) > previousRows) {
			growth += 1;
			sinceGrowth = 0;
		} else {
			sinceGrowth += 1;
		}
		previousRows = last?.mountedRows ?? previousRows;
		const atTop = (last?.scrollTop ?? 1) <= 2;
		if (growth >= requireGrowth && (atTop || sinceGrowth > 40)) break;
	}
	const samples = await page.call("window.__hip.stopAnchorRecorder()");
	const analysis = analyzeAnchor(samples);
	const scrolledUpPx = (first?.scrollTop ?? 0) - (last?.scrollTop ?? 0);
	return {
		steps,
		growth,
		requireGrowth,
		scrolledUpPx,
		reachedTop: (last?.scrollTop ?? null) !== null && last.scrollTop <= 2,
		loadedDuringWheel: last?.loadedCount ?? null,
		samples,
		...analysis,
		metric: "topRowDistanceToTail（可见顶行距尾部行数，行粒度，主判据）",
		auxMetric: "tailDistancePx = scrollHeight - scrollTop（辅助，会受下方内容长高影响）",
	};
}

/** 锚点分析：上滚时「可见顶行距尾部行数」单调不减；另给一份排除补挂瞬时窗口的计数 */
function analyzeAnchor(samples) {
	const list = samples ?? [];
	const rowsChangedAt = [];
	for (let i = 1; i < list.length; i++) {
		if (list[i].mountedRows !== list[i - 1].mountedRows) rowsChangedAt.push(list[i].time);
	}
	const inExpansionTransient = (time) =>
		rowsChangedAt.some((changedAt) => time >= changedAt && time - changedAt <= 400);
	let violations = 0;
	let violationsExcludingExpansionTransient = 0;
	let maxBackstepRows = 0;
	let auxViolations = 0;
	for (let i = 1; i < list.length; i++) {
		const previous = list[i - 1].topRowDistanceToTail;
		const current = list[i].topRowDistanceToTail;
		if (previous !== null && current !== null && current - previous < 0) {
			violations += 1;
			maxBackstepRows = Math.max(maxBackstepRows, previous - current);
			if (!inExpansionTransient(list[i].time)) violationsExcludingExpansionTransient += 1;
		}
		if (list[i].tailDistancePx - list[i - 1].tailDistancePx < -2) auxViolations += 1;
	}
	return {
		sampleCount: list.length,
		expansionCount: rowsChangedAt.length,
		violations,
		violationsExcludingExpansionTransient,
		maxBackstepRows,
		auxViolations,
	};
}

/** 按打点把帧间隔/长任务切成阶段段（mount 与 wheel+expand 至少两段） */
function segmentBetween(probe, fromLabel, toLabel) {
	const marks = probe.marks ?? [];
	const from = marks.find((mark) => mark.label === fromLabel);
	const to = marks.find((mark) => mark.label === toLabel);
	if (!from || !to) return { from: fromLabel, to: toLabel, missingMarks: true };
	const frames = (probe.frames ?? []).filter((frame) => frame.time >= from.time && frame.time <= to.time);
	const longTasks = (probe.longTasks ?? []).filter(
		(task) => task.start >= from.time && task.start <= to.time,
	);
	return {
		from: fromLabel,
		to: toLabel,
		frameCount: frames.length,
		maxFrameGapMs: frames.length ? Math.round(Math.max(...frames.map((frame) => frame.gap)) * 10) / 10 : null,
		maxLongTaskMs: longTasks.length ? Math.round(Math.max(...longTasks.map((task) => task.duration))) : 0,
		longTaskCount: longTasks.length,
	};
}

/** 自检用的「合法」基线轮记录（形状与 runBaseline 产物一致） */
function makeGoodBaselineEntry(scenario) {
	return {
		afterMount: {
			scrollHeight: 4000,
			scrollTop: 4000,
			imgCount: scenario.count,
			loadedCount: scenario.count,
		},
		afterExpand: { scrollHeight: 12000 },
		final: {
			scrollHeight: 12000,
			imgCount: scenario.count,
			loadedCount: scenario.count,
			blank: false,
			errorBoundary: false,
		},
		peakRss: [{ pid: 1, type: "Tab", rssMb: 500 }],
		probe: { maxFrameGapMs: 200, maxLongTaskMs: 220 },
		wheel: {
			steps: 130,
			growth: 3,
			sampleCount: 134,
			scrolledUpPx: 4732,
			violations: 0,
			violationsExcludingExpansionTransient: 0,
			maxBackstepRows: 0,
			auxViolations: 3,
		},
	};
}

/**
 * 基线有效性断言自检：把「合法轮记录」按已知失败模式变异，确认 evaluateBaselineEntry 会红灯。
 * 顺带钉住一条纪律：锚点违规在**基线模式**是观测结果（informational），不能反过来否掉基线。
 */
function baselineSelfTest() {
	const cases = [];
	const check = (name, scenario, mutate, expectFail) => {
		const entry = JSON.parse(JSON.stringify(makeGoodBaselineEntry(scenario)));
		mutate(entry);
		const failures = evaluateBaselineEntry(scenario, entry).failures.map((failure) => failure.id);
		const caught = failures.length > 0;
		cases.push({ name, expectFail, caught, ok: caught === expectFail, failures: failures.slice(0, 4) });
	};
	const longScenario = { key: "show-120-4k", count: 120, expectsExpansion: true };
	const noneScenario = { key: "none", count: 0 };

	check("合法轮记录不报错", longScenario, () => {}, false);
	check(
		"缺主进程工作集",
		longScenario,
		(entry) => {
			entry.peakRss = [];
		},
		true,
	);
	check(
		"白屏 / 错误边界",
		longScenario,
		(entry) => {
			entry.final.blank = true;
		},
		true,
	);
	check(
		"已挂图未全部加载",
		longScenario,
		(entry) => {
			entry.final.loadedCount = longScenario.count - 1;
		},
		true,
	);
	check(
		"图片没挂满（窗口没走完）",
		longScenario,
		(entry) => {
			entry.final.imgCount = longScenario.count - 1;
		},
		true,
	);
	check(
		"滚轮没有真位移",
		longScenario,
		(entry) => {
			entry.wheel.scrolledUpPx = 0;
		},
		true,
	);
	check(
		"滚轮没触发补挂（覆盖不足）",
		longScenario,
		(entry) => {
			entry.wheel.growth = 1;
		},
		true,
	);
	check(
		"锚点采样点太少",
		longScenario,
		(entry) => {
			entry.wheel.sampleCount = 2;
		},
		true,
	);
	check(
		"找不到滚动容器",
		longScenario,
		(entry) => {
			entry.afterMount.scrollHeight = null;
		},
		true,
	);
	check(
		"锚点违规是观测结果，不否基线",
		longScenario,
		(entry) => {
			entry.wheel.violations = 5;
			entry.wheel.violationsExcludingExpansionTransient = 2;
			entry.wheel.maxBackstepRows = 3;
		},
		false,
	);
	check(
		"无图场景混进图片",
		noneScenario,
		(entry) => {
			entry.final.imgCount = 3;
		},
		true,
	);

	return { cases, failed: cases.filter((item) => !item.ok) };
}

/**
 * 基线每轮的**有效性**断言（measurement validity）：这些不成立这轮数据就没意义。
 * 注意：滚动锚点「违规数」是**观测结果**，不是有效性断言——基线可能真的存在回弹，
 * 那正是要记录的；到阶段 3 的 verify 模式才把它变成硬门槛。
 */
function evaluateBaselineEntry(scenario, entry) {
	const checks = [];
	const add = (id, level, ok, detail) => {
		checks.push({ id, level, ok: Boolean(ok), detail: detail === undefined ? null : detail });
	};
	add(
		"scroller:present",
		"mandatory",
		entry.afterMount?.scrollHeight !== null,
		entry.afterMount?.scrollHeight,
	);
	add("page:not-blank", "mandatory", entry.final?.blank === false && entry.final?.errorBoundary === false, {
		blank: entry.final?.blank,
		errorBoundary: entry.final?.errorBoundary,
	});
	add("main:metrics", "mandatory", (entry.peakRss ?? []).length > 0, (entry.peakRss ?? []).length);
	if (scenario.count > 0) {
		add(
			"images:all-mounted",
			"mandatory",
			entry.final?.imgCount === scenario.count,
			`${entry.final?.imgCount}/${scenario.count}`,
		);
		add(
			"images:loaded",
			"mandatory",
			entry.final?.imgCount > 0 && entry.final?.loadedCount === entry.final?.imgCount,
			`${entry.final?.loadedCount}/${entry.final?.imgCount}`,
		);
	} else {
		add("images:none-expected", "mandatory", entry.final?.imgCount === 0, entry.final?.imgCount);
	}
	if (scenario.expectsExpansion) {
		add("wheel:samples", "mandatory", (entry.wheel?.sampleCount ?? 0) >= 5, entry.wheel?.sampleCount);
		add("wheel:expansion-covered", "mandatory", (entry.wheel?.growth ?? 0) >= 2, entry.wheel?.growth);
		add(
			"wheel:real-displacement",
			"mandatory",
			(entry.wheel?.scrolledUpPx ?? 0) > 0,
			entry.wheel?.scrolledUpPx,
		);
		add(
			"wheel:anchor-violations",
			"informational",
			entry.wheel?.violationsExcludingExpansionTransient === 0,
			{
				violations: entry.wheel?.violations,
				excludingTransient: entry.wheel?.violationsExcludingExpansionTransient,
				maxBackstepRows: entry.wheel?.maxBackstepRows,
				auxViolations: entry.wheel?.auxViolations,
			},
		);
	} else {
		add("wheel:not-applicable", "informational", true, {
			reason: "该样本不要求补挂（内容不溢出或初始窗口已覆盖）",
			scrolledUpPx: entry.wheel?.scrolledUpPx ?? null,
		});
	}
	return { checks, failures: checks.filter((check) => check.level === "mandatory" && !check.ok) };
}

/**
 * 快速切会话样本：两个已挂满的会话（40×4K show_image ↔ 40×2000 用户图）来回切 6 次，
 * 按打点把帧间隔切开，看单次切换的长任务/帧间隔成本（就绪后的切换不是冷启动）。
 */
async function runSwitchRound(page, main, round) {
	const sessionA = `hip-switch-a-r${round}-${Date.now()}`;
	const sessionB = `hip-switch-b-r${round}-${Date.now()}`;
	await reloadApp(page);
	await setViewport(page, VIEWPORT.width, VIEWPORT.height);
	const cleared = await page.call("window.__hip.clearSessions()", 30_000);
	const fixtures = [];
	fixtures.push(
		await page.call(
			`window.__hip.makeFixtures(${JSON.stringify({ pool: "A", kind: "png", count: 40, width: 3840, height: 2160, tag: `switchA-r${round}` })})`,
			LONG_TIMEOUT_MS,
		),
	);
	fixtures.push(
		await page.call(
			`window.__hip.makeFixtures(${JSON.stringify({ pool: "B", kind: "jpeg", count: 40, width: 2000, height: 1250, tag: `switchB-r${round}` })})`,
			LONG_TIMEOUT_MS,
		),
	);
	const planA = Array.from({ length: 40 }, () => ({ kind: "image", imageCount: 1 }));
	const planB = Array.from({ length: 40 }, () => ({ kind: "user", imageCount: 1 }));
	const poller = startMemoryPoll(main);

	const mountedA = await page.call(
		`window.__hip.beginRound(${JSON.stringify({ sessionId: sessionA, plan: planA, pool: "A" })})`,
		60_000,
	);
	await sleep(2500);
	await page.call("window.__hip.scrollUpAll({ steps: 6, stepMs: 300 })", 60_000);
	await sleep(1500);
	await page.call(`window.__hip.mark("phase:mount:end")`);
	const mountedB = await page.call(
		`window.__hip.beginRound(${JSON.stringify({
			sessionId: sessionB,
			plan: planB,
			pool: "B",
			keepProbe: true,
			phaseLabel: "phase:loadB:start",
		})})`,
		60_000,
	);
	await sleep(2500);
	await page.call("window.__hip.scrollUpAll({ steps: 6, stepMs: 300 })", 60_000);
	await sleep(1500);
	const beforeSwitch = await page.call("window.__hip.metrics()");
	await page.call(`window.__hip.mark("phase:loadB:end")`);

	await page.call(
		`window.__hip.switchMeasure(${JSON.stringify({ ids: [sessionA, sessionB], times: 6, holdMs: 900 })})`,
		60_000,
	);
	const probe = await page.call("window.__hip.stopProbe()");
	const final = await page.call("window.__hip.metrics()");
	const peak = await poller.stop();

	const switches = segmentByMarks(probe);
	const checks = [];
	const add = (id, level, ok, detail) => {
		checks.push({ id, level, ok: Boolean(ok), detail: detail === undefined ? null : detail });
	};
	add(
		"switch:phases-sampled",
		"mandatory",
		probe.marks.some((item) => item.label === "phase:loadB:end"),
		probe.marks.map((item) => item.label),
	);
	add("switch:count", "mandatory", switches.length === 6, switches.length);
	add(
		"switch:frames-sampled",
		"mandatory",
		switches.every((item) => item.maxFrameGapMs !== null && item.frameCount > 0),
		switches.map((item) => item.frameCount),
	);
	add("main:metrics", "mandatory", peak.length > 0, peak.length);
	add("page:not-blank", "mandatory", final?.blank === false && final?.errorBoundary === false, {
		blank: final?.blank,
		errorBoundary: final?.errorBoundary,
	});
	await page.call("window.__hip.resetAll()", 30_000);
	return {
		round,
		clearedSessions: cleared,
		fixtures,
		mountedA,
		mountedB,
		beforeSwitch,
		switches,
		probe: {
			maxFrameGapMs: probe.maxFrameGapMs,
			maxLongTaskMs: probe.maxLongTaskMs,
			longTaskCount: probe.longTaskCount,
			jsHeapMb: probe.jsHeapMb,
			phases: {
				loadA: segmentBetween(probe, "phase:mount:start", "phase:mount:end"),
				loadB: segmentBetween(probe, "phase:loadB:start", "phase:loadB:end"),
			},
		},
		final,
		peakRss: peak.slice(0, 6),
		rendererPeakRssMb: (peak.find((metric) => metric.type === "Tab") ?? peak[0])?.rssMb ?? null,
		checks,
		failures: checks.filter((check) => check.level === "mandatory" && !check.ok),
	};
}

/** 把切会话那轮的帧间隔按 switch:begin / switch:end:<id> 打点切开 */
function segmentByMarks(probe) {
	const segments = [];
	const marks = probe.marks ?? [];
	for (let i = 0; i < marks.length; i++) {
		const mark = marks[i];
		if (!mark.label.startsWith("switch:end:")) continue;
		let begin = 0;
		for (let j = i - 1; j >= 0; j--) {
			if (marks[j].label === "switch:begin") {
				begin = marks[j].time;
				break;
			}
		}
		const frames = (probe.frames ?? []).filter((frame) => frame.time >= begin && frame.time <= mark.time);
		const longTasks = (probe.longTasks ?? []).filter(
			(task) => task.start >= begin && task.start <= mark.time,
		);
		segments.push({
			target: mark.label.slice("switch:end:".length),
			maxFrameGapMs: frames.length
				? Math.round(Math.max(...frames.map((frame) => frame.gap)) * 10) / 10
				: null,
			frameCount: frames.length,
			maxLongTaskMs: longTasks.length ? Math.max(...longTasks.map((task) => task.duration)) : 0,
		});
	}
	return segments;
}

async function runBaseline(page, main, opts) {
	const env = await page.call("window.__hip.env()");
	if (env.protocol === "file:") {
		console.error("[env] baseline 模式需要 dev 实例（要 import /src/stores/*），当前是 build 产物");
		return { exitCode: EXIT_ENV };
	}
	const rounds = opts.rounds;
	const scenarios = BASELINE_SCENARIOS.filter(
		(scenario) => !opts.scenarios || opts.scenarios.includes(scenario.key),
	);
	if (!main) {
		console.error("[env] baseline 需要主进程调试端口 9229：进程工作集是基线必录项，不能缺项静默通过");
		return { exitCode: EXIT_ENV };
	}
	const selfTest = baselineSelfTest();
	const assertions = { checks: 0, failures: [], selfTest };
	const report = {
		mode: "baseline",
		label: opts.label ?? null,
		startedAt: new Date().toISOString(),
		env,
		rounds,
		scenarios: [],
		mainMetrics: true,
		memorySampleIntervalMs: 250,
		assertions,
	};
	const write = async () => {
		await mkdir(TMP_DIR, { recursive: true });
		await writeFile(opts.out, JSON.stringify(report, null, 2));
	};

	report.viewport = await setViewport(page, VIEWPORT.width, VIEWPORT.height);
	console.log(
		`视口：${JSON.stringify(report.viewport)} · 主进程指标：${report.mainMetrics ? "有" : "无（9229 未开）"}`,
	);

	for (const scenario of scenarios) {
		const scenarioReport = { key: scenario.key, label: scenario.label, rounds: [] };
		report.scenarios.push(scenarioReport);
		for (let round = 1; round <= rounds; round++) {
			if (scenario.key === "switch") {
				const entry = await runSwitchRound(page, main, round);
				scenarioReport.rounds.push(entry);
				assertions.checks += entry.checks.length;
				assertions.failures.push(
					...entry.failures.map((failure) => `${scenario.key} r${round}: ${failure.id}`),
				);
				await write();
				console.log(
					[
						`[switch r${round}] 切 ${entry.switches.length} 次`,
						`单次最大帧间隔 ${entry.switches.map((item) => item.maxFrameGapMs).join("/")}ms`,
						`加载阶段帧间隔 A ${entry.probe.phases.loadA.maxFrameGapMs} / B ${entry.probe.phases.loadB.maxFrameGapMs}ms`,
						`工作集峰值 ${entry.rendererPeakRssMb}MiB`,
						`编码 ${entry.fixtures.map((fixture) => fixture.encodeMs).join("+")}ms`,
						entry.failures.length ? `断言失败 ${entry.failures.map((failure) => failure.id).join(",")}` : "",
					]
						.filter(Boolean)
						.join(" · "),
				);
				continue;
			}
			const sessionId = `hip-${scenario.key}-r${round}-${Date.now()}`;
			await reloadApp(page);
			await setViewport(page, VIEWPORT.width, VIEWPORT.height);
			const cleared = await page.call("window.__hip.clearSessions()", 30_000);
			const fixture = await page.call(
				`window.__hip.makeFixtures(${JSON.stringify({
					pool: "main",
					kind: scenario.kind === "user" ? "jpeg" : "png",
					count: scenario.count,
					width: scenario.width || 800,
					height: scenario.height || 500,
					tag: `${scenario.key}-r${round}`,
				})})`,
				LONG_TIMEOUT_MS,
			);
			const plan = planForScenario(scenario);
			const poller = startMemoryPoll(main);
			let entry = null;
			try {
				const mounted = await page.call(
					`window.__hip.beginRound(${JSON.stringify({ sessionId, plan, pool: "main" })})`,
					60_000,
				);
				await sleep(2500);
				const afterMount = await page.call("window.__hip.metrics()");
				const srcKinds = await page.call("window.__hip.imgSrcKinds()");
				await page.call(`window.__hip.mark("phase:mount:end")`);
				const wheel = await wheelExpandProbe(page, {
					requireGrowth: scenario.expectsExpansion ? 2 : 0,
				});
				const afterExpand = await page.call("window.__hip.metrics()");
				await page.call(`window.__hip.mark("phase:expand:end")`);
				// 补挂之后还要把窗口走完（程序性置顶只用于「把行挂满」，锚点结论只看上面的真实滚轮）
				await page.call("window.__hip.scrollUpAll({ steps: 10, stepMs: 300 })", 60_000);
				await sleep(2000);
				const probe = await page.call("window.__hip.stopProbe()");
				const final = await page.call("window.__hip.metrics()");
				const finalSrcKinds = await page.call("window.__hip.imgSrcKinds()");
				const peak = await poller.stop();
				const rendererPeak = peak.find((metric) => metric.type === "Tab") ?? peak[0] ?? null;
				entry = {
					round,
					sessionId,
					fixture,
					clearedSessions: cleared,
					mounted,
					afterMount,
					afterExpand,
					probe: {
						maxFrameGapMs: probe.maxFrameGapMs,
						maxLongTaskMs: probe.maxLongTaskMs,
						longTaskCount: probe.longTaskCount,
						longTasks: probe.longTasks.slice(0, 40),
						jsHeapMb: probe.jsHeapMb,
						phases: {
							mount: segmentBetween(probe, "phase:mount:start", "phase:mount:end"),
							expand: segmentBetween(probe, "phase:mount:end", "phase:expand:end"),
						},
					},
					final,
					srcKinds,
					finalSrcKinds,
					wheel,
					peakRss: peak.slice(0, 6),
					rendererPeakRssMb: rendererPeak ? rendererPeak.rssMb : null,
				};
			} finally {
				// 出错也必须收尾：停采样、停内存轮询、把 renderer 里的合成会话清掉
				await page.call("window.__hip.stopAnchorRecorder()", 30_000).catch(() => {});
				await poller.stop().catch(() => {});
				await page.call("window.__hip.resetAll()", 30_000).catch(() => {});
			}
			const verdict = evaluateBaselineEntry(scenario, entry);
			entry.checks = verdict.checks;
			entry.failures = verdict.failures;
			assertions.checks += verdict.checks.length;
			assertions.failures.push(
				...verdict.failures.map((failure) => `${scenario.key} r${round}: ${failure.id}`),
			);

			scenarioReport.rounds.push(entry);
			await write();
			console.log(
				[
					`[${scenario.key} r${round}]`,
					`挂图 ${entry.afterMount.loadedCount}/${entry.afterMount.imgCount} → 满窗 ${entry.final.loadedCount}/${entry.final.imgCount}`,
					`帧间隔 整轮 ${entry.probe.maxFrameGapMs}ms（挂载 ${entry.probe.phases.mount.maxFrameGapMs} / 滚轮 ${entry.probe.phases.expand.maxFrameGapMs}）`,
					`最长任务 整轮 ${entry.probe.maxLongTaskMs}ms（挂载 ${entry.probe.phases.mount.maxLongTaskMs} / 滚轮 ${entry.probe.phases.expand.maxLongTaskMs}）`,
					`工作集峰值 ${entry.rendererPeakRssMb}MiB`,
					`滚轮 ${entry.wheel?.steps ?? "-"} 步 / 补挂 ${entry.wheel?.growth ?? "-"} 次 / 位移 ${entry.wheel?.scrolledUpPx ?? "-"}px / 锚点违规 ${entry.wheel?.violations ?? "-"}（非补挂瞬时 ${entry.wheel?.violationsExcludingExpansionTransient ?? "-"}）`,
					`编码 ${entry.fixture.encodeMs}ms/${entry.fixture.base64Mb}MB`,
					entry.failures.length ? `断言失败 ${entry.failures.map((failure) => failure.id).join(",")}` : "",
				]
					.filter(Boolean)
					.join(" · "),
			);
		}
	}
	await reloadApp(page);
	console.log(
		`\n基线有效性断言：${assertions.checks - assertions.failures.length}/${assertions.checks} 通过`,
	);
	console.log(
		`基线断言自检：${selfTest.cases.filter((item) => item.ok).length}/${selfTest.cases.length} 通过`,
	);
	for (const item of selfTest.cases) {
		if (!item.ok) console.error(`  FAIL ${item.name} → ${JSON.stringify(item.failures)}`);
	}
	if (selfTest.failed.length > 0) return { exitCode: EXIT_FAIL, report };
	if (assertions.failures.length > 0) {
		for (const failure of assertions.failures) console.error(`  FAIL ${failure}`);
		return { exitCode: EXIT_FAIL, report };
	}
	return { exitCode: EXIT_OK, report };
}

/* -------------------------------------------------------------------- main */

function parseArgs(argv) {
	const opts = { mode: argv[0] ?? null, rounds: 3, label: null, out: null, scenarios: null };
	for (const arg of argv.slice(1)) {
		if (arg.startsWith("--rounds=")) opts.rounds = Number(arg.slice(9)) || 3;
		else if (arg.startsWith("--label=")) opts.label = arg.slice(8);
		else if (arg.startsWith("--out=")) opts.out = arg.slice(6);
		else if (arg.startsWith("--scenarios=")) opts.scenarios = arg.slice(12).split(",").filter(Boolean);
		else console.warn(`[warn] 忽略未知参数：${arg}`);
	}
	return opts;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.mode !== "probe" && opts.mode !== "baseline") {
		console.error(
			"用法：node scripts/check-history-images.mjs <probe|baseline> [--rounds=3] [--scenarios=a,b]",
		);
		process.exit(EXIT_ENV);
	}
	let page = null;
	let mainCdp = null;
	try {
		page = await connectPage();
		// 这三个域是证据链的一部分（CSP 条目走 Log/Runtime，导航走 Page）：开不起来就是环境不满足，
		// 不能 .catch(() => {}) 咽掉——否则「0 违规」可能只是根本没在听。
		await page.send("Runtime.enable");
		await page.send("Log.enable");
		await page.send("Page.enable");
		await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
		mainCdp = await connectMain();
		await installHelpers(page);
	} catch (error) {
		console.error(`[env] 连接/域开启失败：${error.message}`);
		console.error(
			"      先起 dev：cd packages/desktop && npx electron-vite dev -- --remote-debugging-port=9224 --inspect=9229",
		);
		process.exit(EXIT_ENV);
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const out = opts.out ?? join(TMP_DIR, `${opts.mode}-${opts.label ?? "run"}-${stamp}.json`);
	let exitCode = EXIT_OK;
	try {
		if (opts.mode === "probe") {
			const result = await runProbe(page, opts);
			exitCode = result.exitCode;
			await mkdir(TMP_DIR, { recursive: true });
			await writeFile(out, JSON.stringify(result.summary, null, 2));
		} else {
			opts.out = out;
			const result = await runBaseline(page, mainCdp, opts);
			exitCode = result.exitCode;
		}
		console.log(`\n报告：${out}`);
	} catch (error) {
		console.error(`[fail] ${error.stack ?? error.message}`);
		exitCode = EXIT_FAIL;
	} finally {
		page?.close();
		mainCdp?.close();
	}
	process.exit(exitCode);
}

await main();
