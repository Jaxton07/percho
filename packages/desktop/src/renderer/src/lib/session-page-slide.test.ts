import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SESSION_ID_ATTR,
	SESSION_PAGE_ATTR,
	SLIDE_ATTR,
	shouldSlide,
	withSessionSlide,
} from "./session-page-slide";

/**
 * 会话页推/出过渡（spec D4 收尾增强）：能不能播、什么时候拍、什么时候必须放弃。
 * 这些断言锁的都是「拍错了会演出旧内容」这类**静默错**：
 * - 判据（无 API / 减少动态 / 没容器 ⇒ 直接切）
 * - 方向标记与 view-transition-name 必须在 startViewTransition **之前**就位（旧快照是那时拍的）
 * - 新快照要等 `data-session-id` 真的变了；等不到必须 skipTransition（不放演旧内容的假动画）
 * - 结束时擦掉标记与名字；但若已有更新的过渡接手，旧的那次不许擦
 */

class FakeClassList {
	private items = new Set<string>();
	add(cls: string) {
		this.items.add(cls);
	}
	contains(cls: string) {
		return this.items.has(cls);
	}
}

class FakeElement {
	attrs = new Map<string, string>();
	classList = new FakeClassList();
	style: Record<string, string> = {};
	dataset: Record<string, string> = {};
	getAttribute(name: string) {
		return this.attrs.get(name) ?? null;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
	}
	removeAttribute(name: string) {
		this.attrs.delete(name);
	}
}

/** 页面上被观察的容器（`[data-session-page]`） */
class FakePane extends FakeElement {
	constructor(sessionId: string | null) {
		super();
		if (sessionId !== null) this.attrs.set(SESSION_ID_ATTR, sessionId);
	}
	/** 模拟 React 提交：把会话标记换成新的 */
	commit(sessionId: string) {
		this.attrs.set(SESSION_ID_ATTR, sessionId);
	}
}

interface FakeTransition {
	updateCallbackDone: Promise<unknown>;
	finished: Promise<void>;
	skipTransition: ReturnType<typeof vi.fn>;
	/** 触发 finish（resolve finished） */
	finish: () => void;
}

const calls = { start: 0, dirAtStart: null as string | null, nameAtStart: null as string | null };

function stubEnv(options: { pane?: FakePane | null; hasApi?: boolean; reduce?: boolean }) {
	const pane = options.pane === undefined ? new FakePane("parent-1") : options.pane;
	const root = new FakeElement();
	const created: FakeTransition[] = [];
	const doc = {
		documentElement: root,
		querySelector: (selector: string) => (pane && selector.includes(SESSION_PAGE_ATTR) ? pane : null),
		startViewTransition: undefined as unknown,
	};
	if (options.hasApi !== false) {
		doc.startViewTransition = (callback: () => unknown) => {
			calls.start += 1;
			calls.dirAtStart = root.getAttribute(SLIDE_ATTR);
			calls.nameAtStart = pane?.style.viewTransitionName ?? null;
			let finish = () => {};
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const t: FakeTransition = {
				updateCallbackDone: Promise.resolve(callback()),
				finished,
				skipTransition: vi.fn(),
				finish: () => finish(),
			};
			created.push(t);
			return t;
		};
	}
	vi.stubGlobal("document", doc);
	vi.stubGlobal("matchMedia", () => ({ matches: options.reduce === true }));
	vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
		// 每帧推进 100ms 假时间（超时上限 1200ms ⇒ 最多 12 帧就退出）
		now += 100;
		setTimeout(cb, 0);
		return 1;
	});
	return { pane, root, created };
}

let now = 0;
beforeEach(() => {
	now = 0;
	calls.start = 0;
	calls.dirAtStart = null;
	calls.nameAtStart = null;
	vi.stubGlobal("performance", { now: () => now });
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("shouldSlide", () => {
	it("有 API、有容器、没开减少动态 ⇒ 播", () => {
		expect(shouldSlide({ hasApi: true, reduceMotion: false, hasPane: true })).toBe(true);
	});
	it("无 API / 减少动态偏好 / 没容器 ⇒ 一律不播", () => {
		expect(shouldSlide({ hasApi: false, reduceMotion: false, hasPane: true })).toBe(false);
		expect(shouldSlide({ hasApi: true, reduceMotion: true, hasPane: true })).toBe(false);
		expect(shouldSlide({ hasApi: true, reduceMotion: false, hasPane: false })).toBe(false);
	});
});

describe("withSessionSlide 的降级路径：动作照跑、不播动画", () => {
	it("无 API：直接执行动作、返回其返回值，不碰方向标记", async () => {
		const { root } = stubEnv({ hasApi: false });
		await expect(withSessionSlide("push", () => "value")).resolves.toBe("value");
		expect(calls.start).toBe(0);
		expect(root.getAttribute(SLIDE_ATTR)).toBeNull();
	});

	it("prefers-reduced-motion：直接执行动作，不播", async () => {
		const { pane } = stubEnv({ reduce: true });
		await expect(withSessionSlide("pop", async () => 42)).resolves.toBe(42);
		expect(calls.start).toBe(0);
		expect(pane?.style.viewTransitionName).toBeUndefined();
	});

	it("页面上没有容器：直接执行动作，不播", async () => {
		stubEnv({ pane: null });
		await expect(withSessionSlide("push", () => true)).resolves.toBe(true);
		expect(calls.start).toBe(0);
	});
});

describe("withSessionSlide 的正常路径", () => {
	it("方向标记与 view-transition-name 在 startViewTransition 之前就位（旧快照要用）", async () => {
		const { pane, root, created } = stubEnv({});
		const p = withSessionSlide("push", () => {
			(pane as FakePane).commit("child-1");
			return "ok";
		});
		await expect(p).resolves.toBe("ok");
		expect(calls.dirAtStart).toBe("push");
		expect(calls.nameAtStart).toBe("session-page");
		// 过渡结束后擦干净（清理挂在 finished 上，不提前抢跑）
		expect(root.getAttribute(SLIDE_ATTR)).toBe("push");
		expect(created[0]).toBeDefined();
		created[0]?.finish();
		await Promise.resolve();
		await Promise.resolve();
		expect(root.getAttribute(SLIDE_ATTR)).toBeNull();
		expect(pane?.style.viewTransitionName).toBe("");
	});

	it("pop 方向同样先落标记", async () => {
		const { pane } = stubEnv({});
		const p = withSessionSlide("pop", () => {
			(pane as FakePane).commit("parent-1");
			return null;
		});
		await p;
		expect(calls.dirAtStart).toBe("pop");
	});

	it("新快照等的是「会话标记真的变了」：动作里先提交再用返回值，也不会拍成旧内容", async () => {
		const { pane } = stubEnv({});
		let paneIdWhenCallbackReturned: string | null = null;
		const p = withSessionSlide("push", async () => {
			await Promise.resolve(); // 模拟「动作是 async 的」：await 之后才提交
			(pane as FakePane).commit("child-9");
			paneIdWhenCallbackReturned = pane?.getAttribute(SESSION_ID_ATTR) ?? null;
			return "done";
		});
		await expect(p).resolves.toBe("done");
		expect(paneIdWhenCallbackReturned).toBe("child-9");
	});

	it("会话始终没换（导航失败/迟到作废）：skipTransition，不放演旧内容的动画", async () => {
		const { pane, created } = stubEnv({});
		await expect(withSessionSlide("push", () => "noop")).resolves.toBe("noop");
		expect(created).toHaveLength(1);
		expect(created[0]?.skipTransition).toHaveBeenCalledTimes(1);
		expect(pane?.getAttribute(SESSION_ID_ATTR)).toBe("parent-1"); // 没被改动
	});

	it("已有更新的过渡接手时，旧过渡的收尾不许擦掉新标记（token 守卫）", async () => {
		const { pane, root, created } = stubEnv({});
		const first = withSessionSlide("push", () => {
			(pane as FakePane).commit("child-1");
			return 1;
		});
		await first;
		// 第二次导航在第一次 finished 之前就开始（真实场景：连点两次）
		const second = withSessionSlide("pop", () => {
			(pane as FakePane).commit("parent-2");
			return 2;
		});
		await second;
		expect(root.getAttribute(SLIDE_ATTR)).toBe("pop");
		// 现在再让第一次 finished 回来：它必须什么都不做
		created[0]?.finish();
		await Promise.resolve();
		await Promise.resolve();
		expect(root.getAttribute(SLIDE_ATTR)).toBe("pop"); // 新过渡的标记还在
		expect(pane?.style.viewTransitionName).toBe("session-page");
		created[1]?.finish();
		await Promise.resolve();
		await Promise.resolve();
		expect(root.getAttribute(SLIDE_ATTR)).toBeNull(); // 最后一次收尾才清
	});
});
