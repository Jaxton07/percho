import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Contribution } from "./registry";
import { UI_REGIONS } from "./slots";

/**
 * `RegionHost` 的容器语义（尤其是 spec D4 新增的 `leading` 插槽）：
 * 宿主自带 UI（子代理返回入口）与左上区域贡献**共用同一个绝对定位容器** ⇒ 不会重叠；
 * 且总开关关闭 / 无贡献时宿主入口照样渲染（否则「关了 UI 插件就用不了返回」）。
 *
 * 注：本仓 Vitest 是 classic JSX（无自动运行时），且 zustand v5 的 SSR 快照取 `getInitialState()`
 * ——所以这里按本仓既有做法（ProviderRow.test.tsx）用**普通 selector 函数**替换 store，直接喂状态。
 */
const state = vi.hoisted(() => ({
	masterOn: false,
	contributions: {} as Record<string, unknown[]>,
	nonces: {} as Record<string, number>,
}));

vi.mock("./registry", async () => {
	const actual = await vi.importActual<typeof import("./registry")>("./registry");
	return {
		...actual,
		useUiPluginRegistry: (selector: (s: unknown) => unknown) =>
			selector({
				contributions: state.contributions,
				loadNonces: state.nonces,
				reportCrash: () => false,
			}),
	};
});
vi.mock("../stores/ui-plugins", () => ({
	useUiPluginsStore: (selector: (s: unknown) => unknown) => selector({ config: { enabled: state.masterOn } }),
}));
vi.mock("../api", () => ({ getPi: () => ({ uiPluginsSetPluginEnabled: () => Promise.resolve() }) }));

import { RegionHost } from "./RegionHost";

const Leading = () => (
	<button type="button" aria-label="leading-entry">
		←
	</button>
);
const Contribution_ = () => <div data-probe="contribution">contrib</div>;

const contribution: Contribution = {
	pluginName: "p",
	id: "c1",
	exportName: "Contribution_",
	component: Contribution_,
} as unknown as Contribution;

const markup = (leading?: boolean) =>
	renderToStaticMarkup(
		<RegionHost region={UI_REGIONS.CornerTopLeft} leading={leading ? <Leading /> : undefined} />,
	);

beforeEach(() => {
	vi.stubGlobal("React", React); // classic JSX：给产品文件提供 React 全局（仅本文件）
	state.masterOn = false;
	state.contributions = {};
	state.nonces = {};
});

afterEach(() => vi.unstubAllGlobals());

describe("RegionHost · chat.corner.top-left 的 leading 与区域贡献", () => {
	it("总开关关闭：不渲染贡献，但照样渲染宿主入口（容器仍在）", () => {
		state.contributions = { [UI_REGIONS.CornerTopLeft]: [contribution] };
		const html = markup(true);
		expect(html).toContain("leading-entry");
		expect(html).not.toContain("data-probe");
		expect(html).toContain("top-2 left-4"); // 定位仍来自宿主容器
	});

	it("总开关打开 + 有贡献：宿主入口在贡献之前，且同处一个 flex 容器（靠 gap 纵向分隔）", () => {
		state.masterOn = true;
		state.contributions = { [UI_REGIONS.CornerTopLeft]: [contribution] };
		const html = markup(true);
		expect(html).toContain("leading-entry");
		expect(html).toContain("data-probe");
		expect(html.indexOf("leading-entry")).toBeLessThan(html.indexOf("data-probe"));
		expect(html).toContain("flex flex-col gap-2 top-2 left-4");
		expect(
			html.match(/class="pointer-events-none absolute z-20 flex flex-col gap-2 top-2 left-4"/g),
		).toHaveLength(1);
	});

	it("总开关打开但该区域没有贡献：只渲染宿主入口", () => {
		state.masterOn = true;
		const html = markup(true);
		expect(html).toContain("leading-entry");
		expect(html).not.toContain("data-probe");
	});

	it("没有 leading 也没有贡献：整体不渲染（不留空占位容器）", () => {
		expect(markup(false)).toBe("");
		state.masterOn = true;
		expect(markup(false)).toBe("");
		state.contributions = { [UI_REGIONS.CornerTopLeft]: [contribution] };
		expect(markup(false)).toContain("data-probe");
	});

	it("leading 不会泄漏到非角区域（那里没有共用容器语义）", () => {
		state.masterOn = true;
		const html = renderToStaticMarkup(
			<RegionHost region={UI_REGIONS.ComposerFooter} leading={<Leading />} />,
		);
		expect(html).toBe("");
	});
});
