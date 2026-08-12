/**
 * 开屏动画（黑白哑光粒子光团 → 散场）控制。
 * 样式 = styles/splash.css（link 渲染阻塞，首帧前就绪）；DOM = splash-dom.ts 首帧前生成；
 * 这里只负责三件事：最短/最长展示时长、就绪后打 data-app-ready 触发收場、收場后移除 DOM。
 */

/** 最短展示时长：能看到粒子团聚拢 + 一次呼吸 + 一道声纳波纹 */
const MIN_DISPLAY_MS = 2500;
/** 最长兜底：backend 异常慢时也保证收場（超 2.4s 会露出慢加载细线） */
const MAX_DISPLAY_MS = 4500;
/** 收場时长（与 splash.css 收場编排同步：主界面 1.35s 延迟 + 淡入 1s = 2.35s 后一切落定） */
const EXIT_MS = 2400;
const EXIT_MS_REDUCED = 300;
/** 同次运行只播一次（macOS activate 重建窗口不重播；调试重播 = devtools 清此键） */
const PLAYED_KEY = "pi-splash-played";

let finished = false;

function markPlayed(): void {
	try {
		sessionStorage.setItem(PLAYED_KEY, "1");
	} catch {
		// sessionStorage 不可用时静默失败（下次重建窗口会重播，可接受）
	}
}

function alreadyPlayed(): boolean {
	try {
		return sessionStorage.getItem(PLAYED_KEY) === "1";
	} catch {
		return false;
	}
}

function removeSplash(): void {
	document.getElementById("splash")?.remove();
}

/** 模块加载即调用：同次运行已播过则直接跳过；否则挂最长兜底定时器 */
export function initSplash(): void {
	if (alreadyPlayed()) {
		finished = true;
		// splash.css 常驻，#root 初始 visibility:hidden —— 跳过时也要放出主界面
		document.documentElement.dataset.appReady = "true";
		removeSplash();
		return;
	}
	window.setTimeout(finishSplash, MAX_DISPLAY_MS);
}

/** 应用就绪后调用（幂等）：满最短展示时长后触发收場 */
export function finishSplash(): void {
	if (finished) return;
	finished = true;
	markPlayed();
	const wait = Math.max(0, MIN_DISPLAY_MS - performance.now());
	window.setTimeout(() => {
		document.documentElement.dataset.appReady = "true";
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		window.setTimeout(removeSplash, reduced ? EXIT_MS_REDUCED : EXIT_MS);
	}, wait);
}
