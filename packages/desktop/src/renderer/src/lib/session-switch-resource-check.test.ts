import { describe, expect, it } from "vitest";
import type { ThumbnailService } from "../components/chat/history-image/history-image-service";
import { assertSwitchResourceBudget, assertSwitchResourcesReleased } from "./session-switch-resource-check";

const base = {
	active: 0,
	waiting: 0,
	urls: 0,
	cacheEntries: 128,
	cacheBytes: 16 * 1024 * 1024,
	outstandingRequests: 0,
	inFlight: false,
} as ReturnType<ThumbnailService["stats"]>;
const source = { views: 0, metadata: 128, parses: 0, peakViews: 1 };
describe("切换诊断资源硬门", () => {
	it("只接受产品实际预算，GC可保留有界Blob但不留句柄和源", () => {
		expect(() =>
			assertSwitchResourceBudget({ ...base, active: 48, waiting: 48, urls: 48, outstandingRequests: 1 }, 2),
		).not.toThrow();
		expect(() => assertSwitchResourcesReleased(base, source)).not.toThrow();
	});
	it.each([
		{ active: 49 },
		{ waiting: 49 },
		{ urls: 49 },
		{ cacheEntries: 129 },
		{ cacheBytes: 16 * 1024 * 1024 + 1 },
		{ outstandingRequests: 2 },
	])("预算越界明确失败：%j", (override) => {
		expect(() => assertSwitchResourceBudget({ ...base, ...override }, 0)).toThrow("budget");
	});
	it("不能扩大取图并发或把未卸载/缺失计数当成功", () => {
		expect(() => assertSwitchResourceBudget(base, 3)).toThrow();
		for (const override of [
			{ active: 1 },
			{ urls: 1 },
			{ waiting: 1 },
			{ outstandingRequests: 1 },
			{ inFlight: true },
		])
			expect(() => assertSwitchResourcesReleased({ ...base, ...override }, source)).toThrow("retained");
		for (const invalid of [undefined, { ...source, views: 1 }, { ...source, metadata: 129 }])
			expect(() => assertSwitchResourcesReleased(base, invalid)).toThrow("retained");
	});
});
