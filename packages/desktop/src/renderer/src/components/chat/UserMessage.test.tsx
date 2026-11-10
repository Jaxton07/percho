// @vitest-environment happy-dom
import { type ComposerPart, composerDocumentText } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "../../stores/transcript";
import { UserMessage } from "./UserMessage";

const actions = vi.hoisted(() => ({ copy: vi.fn(), recall: vi.fn() }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("./message-actions", () => ({
	CopyButton: (props: unknown) => {
		actions.copy(props);
		return null;
	},
	RecallButton: (props: unknown) => {
		actions.recall(props);
		return null;
	},
}));

type User = Extract<UIMessage, { kind: "user" }>;
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let height: number;
let lineHeight: number;
const observers = new Map<Element, () => void>();
const disconnect = vi.fn();

beforeEach(() => {
	height = 153;
	lineHeight = 25.5;
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("getComputedStyle", () => ({ lineHeight: String(lineHeight) }));
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() => new DOMRect(0, 0, 300, height),
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			private target?: Element;
			constructor(private callback: () => void) {}
			observe(target: Element) {
				this.target = target;
				observers.set(target, this.callback);
			}
			disconnect() {
				if (this.target) observers.delete(this.target);
				disconnect();
			}
		},
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	observers.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function message(reference?: ComposerPart): User {
	const text = "完整正文\n".repeat(7);
	const document = reference
		? { version: 1 as const, parts: [{ type: "text" as const, text }, reference] }
		: undefined;
	return {
		id: "user-1",
		entryId: "entry-1",
		kind: "user",
		text: document ? composerDocumentText(document) : text,
		sourceText: "持久化原始正文",
		document,
		timestamp: 1,
		images: [],
	};
}

const render = (value: User) => act(async () => root.render(<UserMessage message={value} />));
function element(selector: string) {
	const found = container.querySelector(selector);
	if (!found) throw new Error(`Missing ${selector}`);
	return found;
}
const content = () => element(".user-message-text");
const toggle = () => element("button");
const click = () => act(async () => toggle().dispatchEvent(new MouseEvent("click", { bubbles: true })));

const references: ComposerPart[] = [
	{ type: "file", path: "/example/readme.txt", label: "readme.txt", kind: "file" },
	{ type: "file", path: "/example/docs", label: "docs", kind: "directory" },
	{ type: "skill", id: "example-skill", label: "/example-skill" },
];

describe("用户引用消息共用正文折叠", () => {
	it("首次测量和切回会话不启用动画，只有手动展开/收起才启用", async () => {
		height = 300;
		const value = message();
		await render(value);
		expect(content().getAttribute("data-collapsed")).toBe("true");
		expect(content().hasAttribute("data-animate")).toBe(false);

		await click();
		expect(content().getAttribute("data-animate")).toBe("true");
		expect(content().hasAttribute("data-collapsed")).toBe(false);
		await click();
		expect(content().getAttribute("data-animate")).toBe("true");
		expect(content().getAttribute("data-collapsed")).toBe("true");

		await act(async () => root.render(null));
		await render(value);
		expect(content().getAttribute("data-collapsed")).toBe("true");
		expect(content().hasAttribute("data-animate")).toBe(false);
		await act(async () => {
			for (const measure of observers.values()) measure();
		});
		expect(content().hasAttribute("data-animate")).toBe(false);
	});

	it.each(references)("长引用消息可展开/收起且保留全文和引用样式：%j", async (reference) => {
		height = 178.5;
		const value = message(reference);
		await render(value);
		expect(content().getAttribute("data-collapsed")).toBe("true");
		expect(content().textContent).toBe(value.text);
		expect(content().querySelector(`.composer-reference-${reference.type}`)).not.toBeNull();
		if (reference.type === "file" && reference.kind === "directory") {
			expect(content().querySelector(".composer-reference-directory")).not.toBeNull();
		}
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		expect(toggle().getAttribute("aria-controls")).toBe(content().id);
		expect(content().contains(toggle())).toBe(false);
		await click();
		expect(content().hasAttribute("data-collapsed")).toBe(false);
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
		expect(toggle().textContent).toBe("message.showLess");
		await click();
		expect(content().getAttribute("data-collapsed")).toBe("true");
		expect(content().textContent).toBe(value.text);
		expect(actions.copy).toHaveBeenLastCalledWith({ text: value.text });
		expect(actions.recall).toHaveBeenLastCalledWith({
			entryId: value.entryId,
			matchText: value.sourceText,
			timestamp: value.timestamp,
		});
	});

	it.each(references)("短引用消息和恰好六行不显示折叠按钮：%j", async (reference) => {
		const value = message(reference);
		if (value.document) {
			value.document.parts[0] = { type: "text", text: "短正文 " };
			value.text = composerDocumentText(value.document);
		}
		height = 25.5;
		await render(value);
		expect(content().hasAttribute("data-collapsed")).toBe(false);
		expect(container.querySelector("button")).toBeNull();
		height = 153;
		await act(async () => {
			for (const measure of observers.values()) measure();
		});
		expect(container.querySelector("button")).toBeNull();
	});

	it("普通文本和旧式 skill 消息仍可折叠，消息替换后恢复默认收起", async () => {
		height = 300;
		await render(message());
		expect(content().getAttribute("data-collapsed")).toBe("true");
		await click();
		expect(content().hasAttribute("data-collapsed")).toBe(false);
		await render({ ...message(), id: "user-2", skill: { name: "example", args: "" } });
		expect(content().getAttribute("data-collapsed")).toBe("true");
	});

	it("同一引用消息刷新保留展开状态，替换消息后默认收起", async () => {
		height = 300;
		const value = message(references[0]);
		await render(value);
		await click();
		await render({ ...value, document: { version: 1, parts: [...(value.document?.parts ?? [])] } });
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
		expect(content().hasAttribute("data-collapsed")).toBe(false);
		await render({ ...message(references[1]), id: "user-2" });
		expect(toggle().getAttribute("aria-expanded")).toBe("false");
		expect(content().getAttribute("data-collapsed")).toBe("true");
	});

	it("引用消息在宽度/字号变化后重新测量，并释放观察器", async () => {
		await render(message(references[0]));
		height = 300;
		await act(async () => {
			for (const measure of observers.values()) measure();
		});
		expect(content().getAttribute("data-collapsed")).toBe("true");
		lineHeight = 50;
		await act(async () => {
			for (const measure of observers.values()) measure();
		});
		expect(container.querySelector("button")).toBeNull();
		await act(async () => root.render(null));
		expect(observers.size).toBe(0);
		expect(disconnect).toHaveBeenCalledOnce();
	});
});
