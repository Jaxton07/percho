import MarkdownRender from "markstream-react/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { markdownParseOptions } from "./markdown-parse-options";
import { plainParagraphNodes } from "./plain-paragraph";

const large = "Synthetic output. ".repeat(6000);
const markup = (text: string, optimized: boolean) =>
	renderToStaticMarkup(
		createElement(MarkdownRender, {
			content: text,
			nodes: optimized ? plainParagraphNodes(text) : undefined,
			final: true,
			fade: false,
			deferNodesUntilVisible: false,
			parseOptions: markdownParseOptions,
		}),
	);

describe("large final plain paragraphs", () => {
	it.each([
		large,
		"你好，世界！这是完整正文。保留原有标点、字母与数字123。 ".repeat(5000),
		"Café 42, κόσμος и текст.  ".repeat(5000),
	])("preserves the original renderer's entire markup and text", (text) => {
		const nodes = plainParagraphNodes(text);
		expect(nodes).toHaveLength(1);
		expect(nodes?.[0]?.raw).toBe(text.trimEnd());
		expect(markup(text, true)).toBe(markup(text, false));
	});
	it("preserves a multi-million-character paragraph without slicing its content", () => {
		const text = "Synthetic output. ".repeat(262144);
		expect(plainParagraphNodes(text)?.[0]?.raw).toHaveLength(text.length - 1);
		expect(markup(text, true)).toBe(markup(text, false));
	});
	it("leaves short text and the whole smooth-streaming lifecycle on the normal renderer", () => {
		expect(plainParagraphNodes("ordinary text")).toBeUndefined();
		expect(plainParagraphNodes(large, { streaming: true })).toBeUndefined();
		expect(plainParagraphNodes(large, { smoothStreaming: true })).toBeUndefined();
	});
	it.each([
		"**bold**",
		"`code`",
		"[link](https://example.com)",
		"www.example.com",
		"foo.com",
		"<b>html</b>",
		"&amp;",
		"$x$",
		"snake_case",
		"...",
		",,",
		"????",
		"\nnext paragraph",
		"\t",
		"\u2028",
		"\\escaped",
		"a@b.com",
	])("falls back when syntax or typography is uncertain: %s", (suffix) => {
		expect(plainParagraphNodes(large + suffix)).toBeUndefined();
	});
	it("does not reinterpret indentation, lists or non-paragraph blocks", () => {
		for (const prefix of ["    ", "1. ", "# ", "> ", "- ", "```\n", "<div>"])
			expect(plainParagraphNodes(prefix + large)).toBeUndefined();
	});
});
