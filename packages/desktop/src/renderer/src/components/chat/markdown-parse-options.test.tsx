import MarkdownRender from "markstream-react/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { markdownParseOptions } from "./markdown-parse-options";

function renderCode(content: string, final = true) {
	const html = renderToStaticMarkup(
		createElement(MarkdownRender, {
			content,
			final,
			parseOptions: markdownParseOptions,
			renderCodeBlocksAsPre: true,
		}),
	);
	return html.match(/<code[^>]*>([\s\S]*?)<\/code>/)?.[1];
}

describe("代码块末尾换行", () => {
	it.each(["`", "~"])("%s 围栏只去掉一次行结束符", (marker) => {
		const fence = marker.repeat(3);
		expect(renderCode(`${fence}js\nconst value = 1;\n${fence}`)).toBe("const value = 1;");
		expect(renderCode(`${fence}js\nfirst\nsecond\n${fence}`)).toBe("first\nsecond");
		expect(renderCode(`${fence}js\nfirst\n\n\n${fence}`)).toBe("first\n\n");
	});

	it("支持 Windows 换行和空代码块", () => {
		expect(renderCode("```js\r\nfirst\r\n\r\n```")).toBe("first\n");
		expect(renderCode("```js\n```")).toBe("");
	});

	it("流式代码尚未闭合时保留换行，闭合后去掉一次", () => {
		expect(renderCode("```js\nfirst\n", false)).toBe("first\n");
		expect(renderCode("```js\nfirst\nsecond", false)).toBe("first\nsecond");
		expect(renderCode("```js\nfirst\n\n```", false)).toBe("first\n");
	});

	it("处理引用和列表内的代码块", () => {
		expect(renderCode("> ```js\n> first\n> \n> ```")).toBe("first\n");
		expect(renderCode("- item\n\n  ```js\n  first\n  ```")).toBe("first");
	});
});
