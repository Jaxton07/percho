import { createHighlighter } from "shiki";

const LANGS = [
	"typescript",
	"tsx",
	"javascript",
	"jsx",
	"bash",
	"shell",
	"json",
	"python",
	"go",
	"rust",
	"css",
	"html",
	"markdown",
	"yaml",
	"diff",
	"sql",
	"toml",
	"xml",
	"java",
];

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null;

function getHighlighter() {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({ themes: ["github-light"], langs: LANGS });
	}
	return highlighterPromise;
}

/** 异步高亮代码；未知语言回落为 text。失败时返回 null（调用方回落纯文本渲染） */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
	try {
		const highlighter = await getHighlighter();
		const resolved = highlighter.getLoadedLanguages().includes(lang as never) ? lang : "text";
		return highlighter.codeToHtml(code, { lang: resolved as never, theme: "github-light" });
	} catch {
		return null;
	}
}
