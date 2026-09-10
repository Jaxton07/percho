import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastsStore } from "./toasts";

let clockStep = 0;

describe("toasts pushExtension（issue #45 限流）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// 模块级去重表跨用例残留：clock 每用例重装回同一墙钟基准，用累积步进保证严格后移（>8s 窗口）
		clockStep += 9000;
		vi.advanceTimersByTime(clockStep);
		useToastsStore.setState({ toasts: [], overflowCount: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("基本入栈：扩展 toast 带原文标题与来源副标题，4.5s 自动退场", () => {
		useToastsStore.getState().pushExtension("error", "MCP: failed", "pi-mcp-adapter");
		let s = useToastsStore.getState();
		expect(s.toasts).toHaveLength(1);
		expect(s.toasts[0]).toMatchObject({
			titleText: "MCP: failed",
			detail: "pi-mcp-adapter",
			severity: "error",
		});
		vi.advanceTimersByTime(4500);
		s = useToastsStore.getState();
		expect(s.toasts).toHaveLength(0);
	});

	it("同源同文 8s 内去重；不同来源同文不去重", () => {
		const push = useToastsStore.getState().pushExtension;
		push("info", "same message", "ext-a");
		push("info", "same message", "ext-a");
		expect(useToastsStore.getState().toasts).toHaveLength(1);
		push("info", "same message", "ext-b");
		expect(useToastsStore.getState().toasts).toHaveLength(2);
		// 可见卡退场（4.5s）但去重窗口（8s）未过：同源同文仍被合并
		vi.advanceTimersByTime(4501);
		expect(useToastsStore.getState().toasts).toHaveLength(0);
		push("info", "same message", "ext-a");
		expect(useToastsStore.getState().toasts).toHaveLength(0);
		// 超窗后同源同文可以再进
		vi.advanceTimersByTime(3500);
		push("info", "same message", "ext-a");
		expect(useToastsStore.getState().toasts).toHaveLength(1);
	});

	it("可见栈上限 3：溢出折叠最老扩展卡并计数；手动 dismiss 递减计数", () => {
		const push = useToastsStore.getState().pushExtension;
		push("info", "m1", "ext");
		push("info", "m2", "ext");
		push("info", "m3", "ext");
		expect(useToastsStore.getState().toasts.map((t) => t.titleText)).toEqual(["m1", "m2", "m3"]);
		expect(useToastsStore.getState().overflowCount).toBe(0);

		push("info", "m4", "ext");
		const s = useToastsStore.getState();
		expect(s.toasts.map((t) => t.titleText)).toEqual(["m2", "m3", "m4"]);
		expect(s.overflowCount).toBe(1);

		// 手动关掉最老可见卡 → 折叠计数 -1
		useToastsStore.getState().dismiss(s.toasts[0]?.id ?? "");
		expect(useToastsStore.getState().overflowCount).toBe(0);
		expect(useToastsStore.getState().toasts.map((t) => t.titleText)).toEqual(["m3", "m4"]);
	});

	it("全部到期自动退场：折叠计数归零", () => {
		const push = useToastsStore.getState().pushExtension;
		push("info", "m1", "ext");
		push("info", "m2", "ext");
		push("info", "m3", "ext");
		push("info", "m4", "ext");
		expect(useToastsStore.getState().overflowCount).toBe(1);
		// 同一 tick 入栈的卡共享退场时刻：一次推进全清
		vi.advanceTimersByTime(4500);
		expect(useToastsStore.getState().toasts).toHaveLength(0);
		expect(useToastsStore.getState().overflowCount).toBe(0);
	});

	it("应用 toast（titleKey）不受扩展限流影响，也不动折叠计数", () => {
		const push = useToastsStore.getState().push;
		push("error", "toast.tabsSaveFailed");
		expect(useToastsStore.getState().toasts).toHaveLength(1);
		expect(useToastsStore.getState().overflowCount).toBe(0);
		// 扩展卡满栈时应用 toast 不被挤出（扩展上限只数 titleText 卡）
		const pushExt = useToastsStore.getState().pushExtension;
		pushExt("info", "m1", "ext");
		pushExt("info", "m2", "ext");
		pushExt("info", "m3", "ext");
		expect(useToastsStore.getState().toasts).toHaveLength(4);
		expect(useToastsStore.getState().overflowCount).toBe(0);
		pushExt("info", "m4", "ext");
		// m1（扩展）被挤出；应用 toast 保留
		expect(useToastsStore.getState().toasts.some((t) => t.titleKey === "toast.tabsSaveFailed")).toBe(true);
	});
});
