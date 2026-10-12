/**
 * 会话页推/出过渡（spec D4 收尾增强）：打开子代理检视页 = 新页从右向左推入（push）、
 * 点返回父会话 = 父页从左向右推回（pop）。用**同文档 View Transitions**实现：
 * 浏览器把切换前后的页面各拍一张快照，我们只接管这两张快照的位移动画 ——
 * 不必把上一页同时挂在 React 树里（双挂会重复跑流式/滚动/图片副作用），
 * 也不必手搓 DOM 克隆（monaco/canvas 的克隆会丢像素）。
 *
 * 三个必须守住的点（踩过才写下来，详见 docs/PITFALLS.md）：
 * 1. **新快照必须在「新内容已提交」之后拍**。打开动作是 async（子会话要从文件装载），
 *    `await action()` 返回时 React 常常还没提交 ⇒ 直接拍会把**旧内容当成新页面**。
 *    这里等页面容器上的 `data-session-id` 真的变了再返回（认 DOM 事实，不赌 React 内部时序）；
 *    等不到（导航失败 / 被迟到判废）就 `skipTransition()`，绝不放一段演旧内容的假动画。
 * 2. **推入与推出的两张快照必须同一时长、同一缓动**，否则两者边缘会脱开、露出底图。
 *    成对关键帧在 globals.css 里定义，时长共用一个变量。
 * 3. **根快照要中性化**（`::view-transition-old/new(root)` 关动画与混合模式）：默认的整页交叉淡化
 *    会把顶栏、左栏一起闪一遍。我们只让聊天页那张快照动，其余部分保持静态。
 *
 * 降级：无 API / `prefers-reduced-motion: reduce` / 找不到页面容器 —— 一律**直接切**（不播，也不假装）。
 */

export type SessionSlideDirection = "push" | "pop";

/** 页面容器的标记属性（App 里挂在聊天列上；过渡只在过渡期间给它加 view-transition-name） */
export const SESSION_PAGE_ATTR = "data-session-page";
/** 页面容器上的会话标记：用来判定「新内容真的提交上屏了」 */
export const SESSION_ID_ATTR = "data-session-id";
/** 方向标记挂在 <html> 上，CSS 按它选关键帧 */
export const SLIDE_ATTR = "data-session-slide";

/** 等新内容提交的上限：超时就跳过过渡（用户看到「切了但没动画」，而不是「动画演了旧内容」） */
const COMMIT_TIMEOUT_MS = 1200;
/** 同一时刻只认最后一次过渡：旧的 finished 回来时不能把新过渡的方向标记擦掉 */
let latestSlide = 0;

/** 是否应该播放过渡（纯判定，单测覆盖） */
export function shouldSlide(env: { hasApi: boolean; reduceMotion: boolean; hasPane: boolean }): boolean {
	return env.hasApi && env.hasPane && !env.reduceMotion;
}

/**
 * 包住一次「会导致聊天页切换会话」的动作：能播就播推/出过渡，否则原样执行。
 * 返回动作自身的返回值（调用方照旧处理结果）。
 */
export async function withSessionSlide<T>(
	direction: SessionSlideDirection,
	action: () => Promise<T> | T,
): Promise<T> {
	const doc = document;
	const pane = doc.querySelector<HTMLElement>(`[${SESSION_PAGE_ATTR}]`);
	const canSlide = shouldSlide({
		hasApi: typeof doc.startViewTransition === "function",
		reduceMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
		hasPane: pane !== null,
	});
	if (!canSlide || !pane) return await action();

	const before = pane.getAttribute(SESSION_ID_ATTR) ?? "";
	const token = ++latestSlide;
	// 方向与名字都必须在过渡开始前就位（旧快照是在 startViewTransition 时拍的）
	doc.documentElement.setAttribute(SLIDE_ATTR, direction);
	pane.style.viewTransitionName = "session-page";

	let result: T | undefined;
	const transition = doc.startViewTransition(async () => {
		result = await action();
		if (!(await waitForPaneSession(pane, before))) transition.skipTransition();
	});
	void transition.finished.finally(() => {
		if (token !== latestSlide) return; // 已经开了新的过渡：标记与名字都归它管
		doc.documentElement.removeAttribute(SLIDE_ATTR);
		pane.style.viewTransitionName = "";
	});
	await transition.updateCallbackDone;
	return result as T;
}

/** 等页面容器的会话标记真的变了（= 新内容已提交上屏）；超时返回 false */
async function waitForPaneSession(pane: HTMLElement, before: string): Promise<boolean> {
	const deadline = performance.now() + COMMIT_TIMEOUT_MS;
	while (performance.now() < deadline) {
		if ((pane.getAttribute(SESSION_ID_ATTR) ?? "") !== before) return true;
		await new Promise((resolve) => requestAnimationFrame(resolve));
	}
	return false;
}
