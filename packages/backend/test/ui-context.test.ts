import { describe, expect, it } from "vitest";
import type { ExtensionDialogHost } from "../src/session/extension-dialog-host";
import { extensionNameFromStack, makeUiContext } from "../src/session/ui-context";

/** issue #28 回归：ctx.ui.theme 必须是契约 Theme 对象（方法可调用），不能是空对象/字符串 */
function fakeDialogs(): ExtensionDialogHost {
	return { ask: async () => undefined } as unknown as ExtensionDialogHost;
}

describe("makeUiContext — ui.theme 契约", () => {
	it("theme 是对象且 fg/bg/bold 等样式方法全部可调用并返回字符串", () => {
		const ui = makeUiContext({ dialogs: fakeDialogs() });
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
		const ui = makeUiContext({ dialogs: fakeDialogs() });
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

describe("makeUiContext — 对话框桥接（D7/D10）", () => {
	it("select/input/editor/editor 走 dialogs.ask；无 deps 时退回取消值", async () => {
		const asks: Array<{ kind: string; fields: unknown; opts: unknown }> = [];
		const dialogs = {
			ask: (kind: string, fields: unknown, opts: unknown) => {
				asks.push({ kind, fields, opts });
				return Promise.resolve(undefined);
			},
		} as unknown as ExtensionDialogHost;
		const ui = makeUiContext({ dialogs });

		void ui.select("t", ["a", "b"], { timeout: 500 });
		void ui.confirm("t", "m");
		void ui.input("t", "ph");
		void ui.editor("t", "# prefill");
		expect(asks).toHaveLength(4);
		expect(asks[0]).toEqual({
			kind: "select",
			fields: { title: "t", options: ["a", "b"] },
			opts: { timeout: 500 },
		});
		expect(asks[1]?.kind).toBe("confirm");
		expect(asks[2]?.fields).toEqual({ title: "t", placeholder: "ph" });
		expect(asks[3]?.fields).toEqual({ title: "t", prefill: "# prefill" });

		// 无 dialogs：全部退回契约取消值，永不伪造输入
		const bare = makeUiContext();
		await expect(bare.select("t", ["a"])).resolves.toBeUndefined();
		await expect(bare.confirm("t", "m")).resolves.toBe(false);
		await expect(bare.input("t")).resolves.toBeUndefined();
		await expect(bare.editor("t")).resolves.toBeUndefined();
	});

	it("confirm 不再路由 PermissionGate（D7）：deps 无 gate 概念，确认走 dialogs", async () => {
		const ui = makeUiContext({ dialogs: fakeDialogs() });
		// fakeDialogs 的 ask 恒 resolve undefined → confirm 落 false（确认链路经 dialogs 而非 gate）
		await expect(ui.confirm("t", "m")).resolves.toBe(false);
	});

	it("setTheme 诚实化：{success:false, error}", () => {
		const ui = makeUiContext();
		expect(ui.setTheme("whatever").success).toBe(false);
		expect(ui.setTheme("whatever").error).toContain("Percho");
	});

	it("notify/onEditorText 携带来源归因回调；未注入时不抛", () => {
		const seen: Array<{ message: string; level: string; source: string }> = [];
		const texts: Array<[string, string]> = [];
		const ui = makeUiContext({
			onNotify: (message, level, source) => seen.push({ message, level, source }),
			onEditorText: (text, source) => texts.push([text, source]),
		});
		ui.notify("hello", "warning");
		ui.setEditorText("draft");
		ui.pasteToEditor("paste");
		expect(seen[0]).toMatchObject({ message: "hello", level: "warning" });
		expect(texts).toEqual([
			["draft", expect.any(String)],
			["paste", expect.any(String)],
		]);
		expect(() => makeUiContext().notify("x", "info")).not.toThrow();
	});
});

describe("extensionNameFromStack", () => {
	it("识别 extensions/ 目录扩展名帧（跳过 index）", () => {
		const stack = ["Error: x", "    at Object.notify (/Users/me/.pi/agent/extensions/my-ext.ts:10:5)"].join(
			"\n",
		);
		expect(extensionNameFromStack(stack)).toBe("my-ext");
	});

	it("识别 npm 包名（含 scope），跳过宿主与加载器帧", () => {
		const stack = [
			"Error: x",
			"    at makeUiContext (/repo/packages/backend/src/session/ui-context.ts:88:5)",
			"    at Object.notify (file:///repo/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:100:20)",
			"    at jiti (/repo/node_modules/jiti/dist/jiti.js:1:1)",
			"    at Object.notify (file:///repo/node_modules/pi-mcp-adapter/dist/index.js:200:3)",
		].join("\n");
		expect(extensionNameFromStack(stack)).toBe("pi-mcp-adapter");
	});

	it("无可用帧返回空串", () => {
		expect(extensionNameFromStack("Error: x\n    at foo (<anonymous>)")).toBe("");
	});
});
