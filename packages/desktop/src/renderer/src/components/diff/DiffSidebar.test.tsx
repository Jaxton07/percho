// @vitest-environment happy-dom
import type { UIMessage, UIToolCall } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionViewStore } from "../../stores/session-view";
import { useSessionsStore } from "../../stores/sessions";
import { useTranscriptStore } from "../../stores/transcript";
import { useUiStore } from "../../stores/ui";
import { DiffSidebar } from "./DiffSidebar";

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
const messages = (id: string, text = "initial"): UIMessage[] => [
	{ kind: "user", id, text: "synthetic", images: [], timestamp: 0 },
	{
		kind: "assistant",
		id: `a:${id}`,
		text: "",
		thinking: "",
		timestamp: 1,
		tools: [0, 1].map(
			(n) =>
				({
					key: `${id}:${n}`,
					id: `${id}:${n}`,
					name: "write",
					args: JSON.stringify({ path: "same.ts", content: `${text}:${n}` }),
					output: "",
					state: "done",
				}) satisfies UIToolCall,
		),
	},
];
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("getComputedStyle", () => ({
		transitionProperty: "all",
		transitionDuration: "0.28s",
		transitionDelay: "0s",
	}));
	useSessionsStore.setState({ activeSessionId: "one", sessions: [], newSessionDraft: null });
	useSessionViewStore.setState({ bySession: {} });
	useTranscriptStore.setState({ bySession: {} });
	useTranscriptStore.getState().loadHistory("one", messages("u1"));
	useUiStore.setState({ diffSidebarOpen: false, diffFocus: null });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function render() {
	await act(() => root.render(<DiffSidebar />));
}
async function open(value: boolean) {
	await act(() => useUiStore.getState().setDiffSidebarOpen(value));
}
async function settle() {
	await act(() => vi.advanceTimersByTime(500));
}

it("空白对话页保留空态和关闭入口，不创建虚构会话状态", async () => {
	useSessionsStore.setState({ activeSessionId: null });
	await render();
	await open(true);
	expect(container.textContent).toContain("diff.empty");
	await act(() =>
		container
			.querySelector(".diff-side-close")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
	);
	await settle();
	expect(container.querySelector(".diff-sidebar-in")).toBeNull();
	expect(Object.keys(useSessionViewStore.getState().bySession)).toEqual(["one"]);
});
it("关闭态没有派生重视图；保留退场后释放，重开显示关闭期间的新内容", async () => {
	await render();
	expect(container.querySelector(".diff-sidebar-in")).toBeNull();
	await open(true);
	expect(container.textContent).toContain("initial:0");
	await open(false);
	expect(container.querySelector(".diff-sidebar-in")).not.toBeNull();
	await settle();
	expect(container.querySelector(".diff-sidebar-in")).toBeNull();
	await act(() => useTranscriptStore.getState().loadHistory("one", messages("u1", "updated")));
	await open(true);
	expect(container.textContent).toContain("updated:0");
});
it("来源定位能展开筛选外卡片的后续段，等待挂载后才消费请求", async () => {
	await act(() => useTranscriptStore.getState().loadHistory("one", [...messages("u1"), ...messages("u2")]));
	useSessionViewStore.getState().setScope("one", "latest");
	const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
	await render();
	await act(() => {
		useUiStore.getState().setDiffFocus("u1:1", "one");
		useUiStore.getState().setDiffSidebarOpen(true);
	});
	expect(useUiStore.getState().diffFocus?.sectionKey).toBe("u1:1");
	expect(container.querySelector('[data-section-key="u1:1"]')).not.toBeNull();
	await settle();
	expect(scroll.mock.instances.at(-1)).toBe(container.querySelector('[data-section-key="u1:1"]'));
	expect(useUiStore.getState().diffFocus).toBeNull();
	expect(useSessionViewStore.getState().bySession.one?.scope).toBe("all");
});
it("不存在或过期会话的目标及时结束，不在换会话后滚动旧目标", async () => {
	const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
	await render();
	await open(true);
	await act(() => useUiStore.getState().setDiffFocus("missing", "one"));
	expect(useUiStore.getState().diffFocus).toBeNull();
	await act(() => useUiStore.getState().setDiffFocus("u1:1", "one"));
	await act(() => {
		useTranscriptStore.getState().loadHistory("two", messages("u2"));
		useSessionsStore.setState({ activeSessionId: "two" });
	});
	await settle();
	expect(scroll).not.toHaveBeenCalled();
	expect(useUiStore.getState().diffFocus).toBeNull();
});

it("重复定位同一卡片保留新高亮，旧计时器不能提前清理", async () => {
	vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
	await render();
	await open(true);
	await act(() => useUiStore.getState().setDiffFocus("u1:0", "one"));
	await settle();
	const card = container.querySelector("details.diff-file-card");
	expect(card?.classList.contains("jump-flash")).toBe(true);
	await act(() => useUiStore.getState().setDiffFocus("u1:1", "one"));
	await settle();
	expect(card?.classList.contains("jump-flash")).toBe(true);
	await act(() => vi.advanceTimersByTime(600));
	expect(card?.classList.contains("jump-flash")).toBe(true);
	await act(() => vi.advanceTimersByTime(700));
	expect(card?.classList.contains("jump-flash")).toBe(false);
});

it("锚点跟随入场几何直到结束，新滚动立即取消旧恢复", async () => {
	class MotionEffect {
		getComputedTiming() {
			return { endTime: 500 };
		}
		getKeyframes() {
			return [{ transform: "scale(.98)" }, { transform: "none" }];
		}
	}
	vi.stubGlobal("KeyframeEffect", MotionEffect);
	let running = true,
		shift = 100;
	const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
	Object.defineProperty(Element.prototype, "getAnimations", {
		configurable: true,
		value: function (this: Element) {
			return this.classList.contains("diff-turn-group")
				? [
						{
							effect: new MotionEffect(),
							get playState() {
								return running ? "running" : "finished";
							},
							pending: false,
						},
					]
				: [];
		},
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this.matches("[data-view-key]")) {
			const scroll = container.querySelector("[data-diff-scroll-root]")?.scrollTop ?? 0;
			return new DOMRect(0, 600 + shift - scroll, 100, 1000);
		}
		return new DOMRect(0, 0, 100, 100);
	});
	try {
		useSessionViewStore.getState().setAnchor("one", { key: "file:u1:same.ts", offset: 0, scrollTop: 600 });
		await render();
		await open(true);
		const scroller = container.querySelector<HTMLElement>("[data-diff-scroll-root]")!;
		expect(scroller.scrollTop).toBe(700);
		await act(() => vi.advanceTimersByTime(30));
		shift = 0;
		running = false;
		await act(() => vi.advanceTimersByTime(30));
		expect(scroller.scrollTop).toBe(600);
		await open(false);
		await settle();
		shift = 100;
		running = true;
		await open(true);
		const next = container.querySelector<HTMLElement>("[data-diff-scroll-root]")!;
		await act(() => next.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 50 })));
		next.scrollTop = 500;
		shift = 0;
		running = false;
		await act(() => vi.advanceTimersByTime(100));
		expect(next.scrollTop).toBe(500);
	} finally {
		if (descriptor) Object.defineProperty(Element.prototype, "getAnimations", descriptor);
		else Reflect.deleteProperty(Element.prototype, "getAnimations");
	}
});
