// @vitest-environment happy-dom
import type { TurnChanges, TurnTiming } from "@percho/shared";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterAll(() => vi.unstubAllGlobals());

vi.mock("../../stores/sessions", () => ({
	useSessionsStore: (selector: (state: unknown) => unknown) => selector({ activeSessionId: null }),
}));
vi.mock("../../stores/ui", () => ({
	useUiStore: (selector: (state: unknown) => unknown) =>
		selector({
			setDiffSidebarOpen: () => {},
			setDiffFocus: () => {},
		}),
}));
vi.mock("../../lib/active-cwd", () => ({ selectActiveCwd: () => null }));
vi.mock("../ui/FilePathMenu", () => ({ FilePathMenu: () => null }));

import { useI18nStore } from "../../i18n";
import { TurnDiffChip } from "./TurnDiffChip";

const timing: TurnTiming = { turnIndex: 0, startedAt: 1000, endedAt: 149_000, outputTokensPerSecond: 42.36 };
const changes: TurnChanges = {
	turnIndex: 0,
	files: [{ path: "src/example.ts", added: 43, removed: 4, sections: [] }],
	totalAdded: 43,
	totalRemoved: 4,
};
function render(options: { timing?: TurnTiming; changes?: TurnChanges; running?: boolean } = {}) {
	const container = document.createElement("div");
	const root = createRoot(container);
	roots.push(root);
	flushSync(() =>
		root.render(
			<TurnDiffChip
				timing={options.timing ?? timing}
				changes={options.changes}
				running={options.running ?? false}
				entering={false}
			/>,
		),
	);
	return container;
}

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) root.unmount();
});
beforeEach(() => useI18nStore.getState().setLanguage("zh"));

describe("轮末平均输出速度", () => {
	it.each([undefined, changes])("有无文件变更都将均速放在计时器之后：%j", (changes) => {
		const container = render({ changes });
		const timer = container.querySelector('[role="timer"]');
		const output = container.querySelector("output");
		expect(timer?.textContent).toBe("2m 28s");
		expect(output?.textContent).toBe("42.4 tokens/s");
		expect(output?.getAttribute("aria-label")).toBe("本轮平均输出速度 42.4 tokens/s");
		if (!timer || !output) throw new Error("Missing timer or speed output");
		expect(timer.compareDocumentPosition(output)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		const title = container.querySelector(".turn-diff-title");
		if (title) expect(output?.compareDocumentPosition(title)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(container.querySelector('[role="tooltip"]')).toBeNull();
		expect(output.hasAttribute("title")).toBe(false);
	});

	it("运行中的轮次不显示尚未定稿的平均速度", () => {
		const container = render({ running: true });
		expect(container.querySelector('[role="timer"]')).not.toBeNull();
		expect(container.querySelector("output")).toBeNull();
		expect(container.querySelector('[role="tooltip"]')).toBeNull();
	});

	it.each([undefined, NaN, Infinity, -1])("旧记录或无效均速 %s 不显示，也不留下分隔点", (speed) => {
		const container = render({ timing: { ...timing, outputTokensPerSecond: speed } });
		expect(container.querySelector("output")).toBeNull();
		expect(container.querySelector(".turn-diff-sep")).toBeNull();
	});

	it("历史工作计时未知时，仍保留可计算的请求均速，不留下多余分隔点", () => {
		const container = render({ timing: { ...timing, endedAt: undefined } });
		expect(container.querySelector('[role="timer"]')).toBeNull();
		expect(container.querySelector("output")?.textContent).toBe("42.4 tokens/s");
		expect(container.querySelector(".turn-diff-sep")).toBeNull();
	});

	it("已知零输出与缺失数据不同，正常显示 0.0 tokens/s", () => {
		expect(
			render({ timing: { ...timing, outputTokensPerSecond: 0 } }).querySelector("output")?.textContent,
		).toBe("0.0 tokens/s");
	});

	it("英文界面保留相同数值与单位，不显示悬浮说明", () => {
		useI18nStore.getState().setLanguage("en");
		const container = render();
		expect(container.querySelector("output")?.textContent).toBe("42.4 tokens/s");
		expect(container.querySelector("output")?.getAttribute("aria-label")).toBe(
			"Average output speed this turn: 42.4 tokens/s",
		);
		expect(container.querySelector('[role="tooltip"]')).toBeNull();
	});
});
