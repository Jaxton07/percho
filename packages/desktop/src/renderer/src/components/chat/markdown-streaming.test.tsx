// @vitest-environment happy-dom
import MarkdownRender from "markstream-react";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { Markdown } from "./Markdown";
import { markdownParseOptions } from "./markdown-parse-options";

vi.hoisted(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
vi.mock("../../api", () => ({ getPi: () => ({ platform: "darwin" }) }));

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
const initialCodeFontSize = useUiPreferencesStore.getState().codeFontSize;

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
	useUiPreferencesStore.setState({ codeFontSize: initialCodeFontSize });
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

describe("切换会话后的流式正文", () => {
	const existing = "切换之前已经显示过的正文。".repeat(30);
	const delta = "切回之后新增的正文。".repeat(30);

	async function renderMessage(text: string, streaming = true, session = "a") {
		await act(async () => {
			root.render(<Markdown key={session} text={text} streaming={streaming} />);
		});
	}

	it("切回仍在执行的会话时立即显示已有正文，只平滑输出新增内容", async () => {
		await renderMessage(existing);
		expect(container.textContent).toContain(existing);
		await renderMessage("另一个会话", false, "b");
		await renderMessage(existing);
		expect(container.textContent).toContain(existing);

		await renderMessage(existing + delta);
		expect(container.textContent).toContain(existing);
		expect(container.textContent).not.toContain(existing + delta);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10000);
		});
		expect(container.textContent).toContain(existing + delta);
	});

	it("输出结束后仍能平滑追完新增内容", async () => {
		await renderMessage(existing);
		await renderMessage(existing + delta, false);
		expect(container.textContent).toContain(existing);
		expect(container.textContent).not.toContain(existing + delta);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10000);
		});
		expect(container.textContent).toContain(existing + delta);
	});

	it("流式中调整代码字号也不重播已有正文", async () => {
		await renderMessage(existing);
		await act(async () => {
			useUiPreferencesStore.setState({ codeFontSize: 14 });
		});
		expect(container.textContent).toContain(existing);
		await renderMessage(existing + delta);
		expect(container.textContent).not.toContain(existing + delta);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10000);
		});
		expect(container.textContent).toContain(existing + delta);
	});

	it("StrictMode 重跑挂载也不重播已有正文", async () => {
		await act(async () => {
			root.render(
				<StrictMode>
					<Markdown text={existing} streaming />
				</StrictMode>,
			);
		});
		expect(container.textContent).toContain(existing);
	});

	it("已完成的历史正文直接显示，调整代码字号也不重播", async () => {
		await renderMessage(existing, false);
		expect(container.textContent).toContain(existing);
		await renderMessage(existing, true);
		await act(async () => {
			useUiPreferencesStore.setState({ codeFontSize: 14 });
		});
		expect(container.textContent).toContain(existing);
	});
});

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
