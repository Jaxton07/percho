// @vitest-environment happy-dom

import type { CacheWarmingInfo } from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getCacheWarming: vi.fn(), setCacheWarming: vi.fn() }));
vi.mock("../../environment-api", () => ({ getExecutionApi: () => api }));

import { translate, useI18nStore } from "../../i18n";
import { CacheWarmingSettings } from "./CacheWarmingSettings";

const info = (mode: CacheWarmingInfo["mode"] = "streaming"): CacheWarmingInfo => ({
	mode,
	sessions: [{ sessionId: "s1", name: "测试会话", mode, state: "inactive", reason: "waiting" }],
});
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	useI18nStore.setState({ language: "zh" });
	api.getCacheWarming.mockResolvedValue(info());
	api.setCacheWarming.mockImplementation(async ({ mode }) => info(mode));
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function render() {
	await act(async () => root.render(<CacheWarmingSettings />));
}
async function choose(label: string) {
	await act(async () => host.querySelector<HTMLButtonElement>('[role="combobox"]')?.click());
	const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
		(option) => option.textContent === label,
	);
	if (!option) throw new Error(`Missing option: ${label}`);
	await act(async () => option.click());
}
it("默认提示说明空闲保温及潜在费用，读取结果仍以真实状态为准", async () => {
	expect(translate("zh", "settings.cacheWarmingHint")).toContain("默认包含空闲时");
	expect(translate("zh", "settings.cacheWarmingHint")).toContain("额外费用");
	expect(translate("en", "settings.cacheWarmingHint")).toContain("Defaults to including idle time");
	expect(translate("en", "settings.cacheWarmingHint")).toContain("extra costs");
	api.getCacheWarming.mockResolvedValueOnce(info("idle"));
	await render();
	expect(host.querySelector('[role="combobox"]')?.textContent).toContain("包含空闲时");
	expect(host.textContent).toContain("等待首次模型请求");
});

it("显示真实模式和会话等待状态，可即时保存；英文同步翻译", async () => {
	await render();
	expect(host.textContent).toContain("仅任务运行时");
	expect(host.textContent).toContain("测试会话");
	expect(host.textContent).toContain("等待首次模型请求");
	await choose("包含空闲时");
	expect(api.setCacheWarming).toHaveBeenCalledWith({ mode: "idle" });
	expect(host.querySelector('[role="combobox"]')?.textContent).toContain("包含空闲时");
	await act(async () => useI18nStore.setState({ language: "en" }));
	expect(host.textContent).toContain("Including idle time");
	expect(host.textContent).toContain("Waiting for the first model request");
});
it("保存失败保留旧模式并展示错误", async () => {
	await render();
	api.setCacheWarming.mockRejectedValueOnce(new Error("disk full"));
	await choose("关闭");
	expect(host.querySelector('[role="combobox"]')?.textContent).toContain("仅任务运行时");
	expect(host.querySelector('[role="alert"]')?.textContent).toBe("disk full");
});
it("保存后到达的旧轮询不能覆盖新模式，卸载时清理轮询", async () => {
	await render();
	let finish!: (value: CacheWarmingInfo) => void;
	api.getCacheWarming.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await act(async () => vi.advanceTimersByTime(5000));
	await choose("关闭");
	await act(async () => finish(info("streaming")));
	expect(host.querySelector('[role="combobox"]')?.textContent).toContain("关闭");
	await act(() => root.unmount());
	root = createRoot(host);
	const calls = api.getCacheWarming.mock.calls.length;
	await act(async () => vi.advanceTimersByTime(10000));
	expect(api.getCacheWarming).toHaveBeenCalledTimes(calls);
});
