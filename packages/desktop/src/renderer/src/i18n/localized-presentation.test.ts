import type { MetaItem, SlashCommandInfo, UIToolCall } from "@percho/shared";
import * as React from "react";
import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
	vi.stubGlobal("navigator", { language: "en" });
});
// SSR 固定读取 Zustand 初始快照；展示测试用真实字典和当前 store 语言替代订阅 hook。
vi.mock("./index", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./index")>();
	return {
		...actual,
		useT: () => (key: Parameters<Translate>[0], params?: Parameters<Translate>[1]) =>
			actual.translate(actual.useI18nStore.getState().language, key, params),
	};
});
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => null }));
vi.mock("../plugins/Slot", () => ({
	Slot: ({
		fallback,
		props,
	}: {
		fallback: ComponentType<{ tool: UIToolCall }>;
		props: { tool: UIToolCall };
	}) => createElement(fallback, props),
}));

import { MetaGroup } from "../components/chat/MetaGroup";
import { summaryLabel } from "../components/chat/meta-summary-label";
import { ToolCallCard } from "../components/chat/ToolCallCard";
import { displayName } from "../components/chat/tool-label";
import { SlashMenu } from "../components/composer/SlashMenu";
import { filterCommands } from "../components/composer/slash-filter";
import { slashPresentation } from "../components/composer/slash-label";
import { type Language, type Translate, translate, useI18nStore } from ".";
import { zh } from "./zh";

const translator =
	(language: Language): Translate =>
	(key, params) =>
		translate(language, key, params);
const t = translator("zh");
const tool: UIToolCall = {
	key: "image",
	id: "image",
	name: "show_image",
	args: "{}",
	output: "",
	state: "done",
};
const compact: SlashCommandInfo = {
	name: "compact",
	description: "Compress session context",
	argumentHint: "[focus]",
	source: "builtin",
	supported: true,
};

beforeEach(() => {
	// Vitest 默认 classic JSX；生产构建由 React 插件使用 automatic JSX。
	vi.stubGlobal("React", React);
	useI18nStore.setState({ language: "zh" });
});

describe("工具名称中文投影", () => {
	it("所有已知内置工具都有中英文名称，未知名称不改写", () => {
		for (const [name, label] of Object.entries(zh.tool.names)) {
			expect(displayName(name, t)).toBe(label);
			expect(displayName(name, translator("en"))).not.toContain("tool.names.");
		}
		for (const name of ["mcp", "custom_tool", "toString"]) {
			expect(displayName(name, t)).toBe(name);
		}
		// MCP 工具是唯一的例外：保留 server 命名空间（`mcp__<server>__<tool>` → `server › tool`）
		expect(displayName("mcp__server__search", t)).toBe("server › search");
	});
	it("插件 API 单参数调用跟随当前语言", () => {
		expect(displayName("show_image")).toBe("展示图片");
		useI18nStore.setState({ language: "en" });
		expect(displayName("show_image")).toBe("Show_image");
	});
	it("卡片与摘要统一翻译，切到英文恢复英文", () => {
		expect(renderToStaticMarkup(createElement(ToolCallCard, { tool }))).toContain("展示图片");
		expect(summaryLabel(t, { key: "webfetch", category: "other", name: "webfetch", count: 2 })).toBe(
			"读取网页 ×2",
		);
		useI18nStore.setState({ language: "en" });
		expect(renderToStaticMarkup(createElement(ToolCallCard, { tool }))).toContain("Show_image");
	});
	it("单独 show_image 也包在外层折叠中，摘要无工具名，明细保留", () => {
		const items: MetaItem[] = [{ thinking: "", tools: [tool] }];
		const html = renderToStaticMarkup(createElement(MetaGroup, { items, working: false }));
		expect(html).toContain("group/outer");
		const outerSummary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
		expect(outerSummary).toContain("已完成");
		expect(outerSummary).not.toContain("展示图片");
		expect(html.slice(html.indexOf("</summary>"))).toContain("展示图片");
	});
});

describe("内置 slash 命令中文投影", () => {
	it("翻译名称、说明、参数提示，执行标识不变", () => {
		expect(slashPresentation(compact, t)).toEqual({
			label: "压缩",
			description: "压缩会话上下文",
			argumentHint: "[关注重点]",
		});
		expect(compact.name).toBe("compact");
		for (const name of ["name", "export", "settings"]) {
			expect(slashPresentation({ ...compact, name }, t).label).toBe(
				zh.slash.builtin[name as keyof typeof zh.slash.builtin].label,
			);
		}
		expect(slashPresentation({ ...compact, name: "settings" }, t).argumentHint).toBeUndefined();
		expect(slashPresentation(compact, translator("en"))).toEqual({
			label: "compact",
			description: compact.description,
			argumentHint: compact.argumentHint,
		});
	});
	it("skill、模板、扩展（包括与内置同名）及未知内置命令原样保留", () => {
		for (const source of ["skill", "template", "extension"] as const) {
			const command = { ...compact, source };
			expect(slashPresentation(command, t)).toEqual({
				label: "compact",
				description: command.description,
				argumentHint: command.argumentHint,
			});
		}
		const unknown = { ...compact, name: "future" };
		expect(slashPresentation(unknown, t).label).toBe("future");
	});
	it("中英文查询共用同一过滤函数，中文名不匹配同名扩展", () => {
		const extension = { ...compact, source: "extension" as const };
		const commands = [compact, extension];
		expect(filterCommands(commands, "压缩", t)).toEqual([compact]);
		expect(filterCommands(commands, "comp", t)).toEqual(commands);
		expect(filterCommands(commands, "压缩", translator("en"))).toEqual([]);
	});
	it("菜单显示中文和原执行标识，说明与参数不再显示英文", () => {
		const html = renderToStaticMarkup(
			createElement(SlashMenu, {
				commands: [compact],
				query: "压缩",
				selectedIndex: 0,
				onSelectedIndexChange: () => {},
				onPick: () => {},
			}),
		);
		expect(html).toContain("压缩");
		expect(html).toContain("/compact");
		expect(html).toContain("[关注重点]");
		expect(html).not.toContain("Compress session context");
		expect(html).not.toContain("[focus]");
	});
});
