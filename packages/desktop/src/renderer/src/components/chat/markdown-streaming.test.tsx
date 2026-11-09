// @vitest-environment happy-dom
import MarkdownRender from "markstream-react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownParseOptions } from "./markdown-parse-options";

// happy-dom 无法运行 Monaco 的布局/worker；只替代编辑器边界，保留真实 Shiki
// 的语言校验和 markstream 的异常处理、组件状态及连续更新。
vi.mock("stream-monaco", async () => {
	const { createHighlighter } = await import("shiki");
	const highlighter = await createHighlighter({ themes: ["vitesse-light"], langs: ["markdown"] });
	return {
		preloadMonacoWorkers: async () => {},
		detectLanguage: () => "plaintext",
		useMonaco: () => {
			let target: HTMLElement | undefined;
			const updateCode = (code: string, language: string) => {
				const html = highlighter.codeToHtml(code, { lang: language, theme: "vitesse-light" });
				if (target) target.innerHTML = html;
			};
			return {
				createEditor: async (element: HTMLElement, code: string, language: string) => {
					target = element;
					updateCode(code, language);
				},
				updateCode,
				getEditorView: () => (target ? {} : undefined),
				safeClean: () => {
					target?.replaceChildren();
					target = undefined;
				},
			};
		},
	};
});

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

beforeEach(async () => {
	// 先等异步编辑器/高亮器加载完，避免断言抢在初始化错误发生前通过。
	await import("stream-monaco");
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 200));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function render(content: string, final = false) {
	await act(async () => {
		root.render(
			<MarkdownRender
				content={content}
				final={final}
				parseOptions={markdownParseOptions}
				fade={false}
				deferNodesUntilVisible={false}
			/>,
		);
	});
	// 推进可见性检查和编辑器布局的帧回调，不依赖真实时间等待。
	await act(async () => {
		await vi.advanceTimersByTimeAsync(100);
	});
	expect(container.querySelector(".code-block-header")).not.toBeNull();
	expect(container.querySelector('button[aria-label="Copy"]')).not.toBeNull();
	expect(container.querySelector(".code-editor-container .shiki")).not.toBeNull();
}

describe("流式代码块", () => {
	it.each([
		["markdown", "ma"],
		["md", "m"],
		["text", "te"],
	])("%s 半截语言名补全并结束输出后保留代码框和复制按钮", async (language, partial) => {
		await render(`\`\`\`${partial}`);
		const header = container.querySelector(".code-block-header");
		await render(`\`\`\`${language}\n# 示例\n内容`);
		await render(`\`\`\`${language}\n# 示例\n内容\n\`\`\``, true);
		expect(container.querySelector(".code-block-header")).toBe(header);
		expect(container.querySelector(".code-editor-container")?.textContent).toContain("内容");
	});
});
