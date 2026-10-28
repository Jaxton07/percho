// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRowsEditor } from "../settings/providers/ModelRowsEditor";
import { EMPTY_MODEL_ROW } from "../settings/providers/model-rows";
import { Select } from "./Select";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
const render = async (element: ReactElement) => {
	await act(() => root.render(element));
};
const click = async (element: HTMLElement) => {
	await act(() => {
		element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		element.click();
	});
};
const key = async (element: Element | null, value: string) => {
	if (!element) throw new Error("Missing keyboard target");
	await act(() =>
		element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })),
	);
};
const menu = () => document.querySelector('[role="listbox"]');
const activeText = () => document.activeElement?.textContent;
const models = [{ id: "a" }, { id: "b" }, { id: "c", contextWindow: 128000, maxTokens: 16384 }];

async function mount(kind: string) {
	const changed = vi.fn();
	await render(
		kind === "select" ? (
			<Select
				value="b"
				options={models.map((m) => ({ value: m.id, label: m.id }))}
				onChange={changed}
				ariaLabel="Models"
			/>
		) : (
			<ModelRowsEditor rows={[{ ...EMPTY_MODEL_ROW, id: "b" }]} upstream={models} onChange={changed} />
		),
	);
	const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
	if (!trigger) throw new Error("Missing select trigger");
	return {
		changed,
		trigger,
		input: host.querySelector<HTMLInputElement>("input"),
	};
}

describe.each(["select", "models"])("%s 复用选择菜单", (kind) => {
	it("再次点击触发按钮收起，外部点击也能关闭", async () => {
		const { trigger } = await mount(kind);
		await click(trigger);
		expect(menu()).not.toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		await click(trigger);
		expect(menu()).toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		await click(trigger);
		await click(host);
		expect(menu()).toBeNull();
	});

	it("方向键展开并导航，Home/End 跳转，Enter 选择并恢复焦点", async () => {
		const { trigger, input, changed } = await mount(kind);
		trigger.focus();
		await key(trigger, "ArrowDown");
		expect(activeText()).toBe("b");
		await key(document.activeElement, "ArrowDown");
		expect(activeText()).toContain("c");
		await key(document.activeElement, "ArrowUp");
		expect(activeText()).toBe("b");
		await key(document.activeElement, "Home");
		expect(activeText()).toBe("a");
		await key(document.activeElement, "End");
		expect(activeText()).toContain("c");
		await key(document.activeElement, "Enter");
		expect(menu()).toBeNull();
		expect(document.activeElement).toBe(input ?? trigger);
		if (kind === "select") expect(changed).toHaveBeenCalledWith("c");
		else
			expect(changed).toHaveBeenCalledWith([
				{ ...EMPTY_MODEL_ROW, id: "c", contextWindow: "128k", maxTokens: "16384" },
			]);
	});

	it("Escape 和 Tab 关闭菜单并恢复焦点，空格可选择", async () => {
		const { trigger, input, changed } = await mount(kind);
		for (const closeKey of ["Escape", "Tab"]) {
			await key(trigger, "ArrowUp");
			expect(menu()).not.toBeNull();
			await key(document.activeElement, closeKey);
			expect(menu()).toBeNull();
			expect(document.activeElement).toBe(input ?? trigger);
		}
		await key(trigger, "ArrowDown");
		await key(document.activeElement, " ");
		expect(changed).toHaveBeenCalledOnce();
		expect(menu()).toBeNull();
	});
});

it("模型输入框也可用方向键展开，能力摘要保留；候选失效后不自动重开", async () => {
	const { input, changed } = await mount("models");
	if (!input) throw new Error("Missing model input");
	input.focus();
	await key(input, "ArrowDown");
	const text = menu()?.textContent;
	expect(text).toContain("128k / 16k");
	await click(input);
	expect(menu()).toBeNull();
	await key(input, "ArrowDown");
	expect(menu()).not.toBeNull();
	await render(<ModelRowsEditor rows={[{ ...EMPTY_MODEL_ROW, id: "b" }]} upstream={[]} onChange={changed} />);
	expect(menu()).toBeNull();
	await render(
		<ModelRowsEditor rows={[{ ...EMPTY_MODEL_ROW, id: "b" }]} upstream={models} onChange={changed} />,
	);
	expect(menu()).toBeNull();
});

it.each([30, 260])("输入字段位于 y=%s 时，菜单保持在窗口内且宽度跟随字段", async (top) => {
	vi.stubGlobal("innerWidth", 400);
	vi.stubGlobal("innerHeight", 300);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		return this.getAttribute("role") === "listbox"
			? new DOMRect(0, 0, 200, 180)
			: new DOMRect(250, top, 200, 30);
	});
	const { input } = await mount("models");
	await key(input, "ArrowDown");
	const list = menu() as HTMLElement | null;
	if (!list) throw new Error("Missing model list");
	const y = Number.parseFloat(list.style.top);
	const x = Number.parseFloat(list.style.left);
	const width = Number.parseFloat(list.style.width);
	const height = Math.min(180, Number.parseFloat(list.style.maxHeight));
	expect(width).toBe(200);
	expect(x).toBeGreaterThanOrEqual(6);
	expect(x + width).toBeLessThanOrEqual(394);
	expect(y).toBeGreaterThanOrEqual(6);
	expect(y + height).toBeLessThanOrEqual(294);
	if (top === 260) expect(y + height).toBeLessThan(top);
	else expect(y).toBeGreaterThan(top + 30);
});
