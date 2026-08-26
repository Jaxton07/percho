import { describe, expect, it } from "vitest";
import type { PermissionGate } from "../src/permissions/gate";
import { makeUiContext } from "../src/session/ui-context";

/** issue #28 回归：ctx.ui.theme 必须是契约 Theme 对象（方法可调用），不能是空对象/字符串 */
function fakeGate(): PermissionGate {
	return { confirm: async () => false } as unknown as PermissionGate;
}

describe("makeUiContext — ui.theme 契约", () => {
	it("theme 是对象且 fg/bg/bold 等样式方法全部可调用并返回字符串", () => {
		const ui = makeUiContext(fakeGate());
		// pi-mcp-adapter init.ts updateStatusBar 的实际用法：ui.theme ? theme.fg(...) : ...
		// 空对象/字符串会让 truthy 判断走进 .fg() 分支抛 TypeError（全部 MCP 服务器连接失败）
		expect(typeof ui.theme).toBe("object");
		expect(ui.theme).not.toBeNull();

		expect(ui.theme.fg("accent", "mcp: ready")).toContain("mcp: ready");
		expect(ui.theme.bg("selectedBg", "x")).toContain("x");
		expect(ui.theme.bold("x")).toContain("x");
		// 其余 Theme 方法也要存在（扩展可能调用任何一个；手写 pass-through 对象漏一个就崩）
		expect(ui.theme.italic("x")).toContain("x");
		expect(ui.theme.underline("x")).toContain("x");
		expect(ui.theme.inverse("x")).toContain("x");
		expect(ui.theme.strikethrough("x")).toContain("x");
		expect(typeof ui.theme.getFgAnsi("accent")).toBe("string");
		expect(typeof ui.theme.getBgAnsi("selectedBg")).toBe("string");
		expect(ui.theme.getColorMode()).toMatch(/truecolor|256color/);
		expect(typeof ui.theme.getThinkingBorderColor("high")).toBe("function");
	});

	it("所有 ThemeColor 枚举值都能被 fg() 接受（色表完整，不会运行时缺色）", () => {
		const ui = makeUiContext(fakeGate());
		const colors = [
			"accent",
			"border",
			"borderAccent",
			"borderMuted",
			"success",
			"error",
			"warning",
			"muted",
			"dim",
			"text",
			"thinkingText",
			"userMessageText",
			"customMessageText",
			"customMessageLabel",
			"toolTitle",
			"toolOutput",
			"mdHeading",
			"mdLink",
			"mdLinkUrl",
			"mdCode",
			"mdCodeBlock",
			"mdCodeBlockBorder",
			"mdQuote",
			"mdQuoteBorder",
			"mdHr",
			"mdListBullet",
			"toolDiffAdded",
			"toolDiffRemoved",
			"toolDiffContext",
			"syntaxComment",
			"syntaxKeyword",
			"syntaxFunction",
			"syntaxVariable",
			"syntaxString",
			"syntaxNumber",
			"syntaxType",
			"syntaxOperator",
			"syntaxPunctuation",
			"thinkingOff",
			"thinkingMinimal",
			"thinkingLow",
			"thinkingMedium",
			"thinkingHigh",
			"thinkingXhigh",
			"bashMode",
		] as const;
		for (const color of colors) {
			expect(ui.theme.fg(color, "t")).toContain("t");
		}
	});
});
