import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：catalog store 经 getPi() 访问，测试环境无 preload 注入 */
const piMock = vi.hoisted(() => ({
	searchCatalog: vi.fn(),
	listConfiguredPackages: vi.fn(),
}));
vi.mock("../api", () => ({ getPi: () => piMock }));

import { useCatalogStore } from "./catalog";

function resetStore() {
	useCatalogStore.setState({
		extensionsTab: "browse",
		catalogQuery: "",
		catalogType: "",
		catalogPackages: [],
		catalogTotal: 0,
		catalogPage: 0,
		catalogLoading: false,
		catalogLoadingMore: false,
		catalogError: null,
		catalogSeq: 0,
		installingNames: {},
		installErrors: {},
		removingSources: {},
		removeErrors: {},
		configuredPackages: null,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	resetStore();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("catalog store：防抖搜索", () => {
	it("setCatalogQuery 后 300ms 才触发一次搜索（防抖合并连续输入）", async () => {
		vi.useFakeTimers();
		piMock.searchCatalog.mockResolvedValue({ packages: [], total: 0, page: 1 });

		const { setCatalogQuery } = useCatalogStore.getState();
		setCatalogQuery("c");
		setCatalogQuery("ca");
		setCatalogQuery("cat");

		// 防抖窗口内未触发
		await vi.advanceTimersByTimeAsync(299);
		expect(piMock.searchCatalog).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(piMock.searchCatalog).toHaveBeenCalledTimes(1);
		expect(piMock.searchCatalog).toHaveBeenCalledWith("cat", "", 1);
	});
});

describe("catalog store：竞态序号", () => {
	it("陈旧响应丢弃：先发后至的搜索结果不写入", async () => {
		let resolveFirst: (v: { packages: { name: string }[]; total: number; page: number }) => void = () => {};
		const first = new Promise<{ packages: { name: string }[]; total: number; page: number }>((r) => {
			resolveFirst = r;
		});
		piMock.searchCatalog
			.mockImplementationOnce(() => first) // 第 1 次搜索：挂起
			.mockResolvedValue({ packages: [{ name: "new" }], total: 1, page: 1 }); // 第 2 次：先完成

		const p1 = useCatalogStore.getState().searchCatalog(false);
		await useCatalogStore.getState().searchCatalog(false);
		// 第 2 次搜索已写入
		expect(useCatalogStore.getState().catalogPackages).toEqual([{ name: "new" }]);

		// 第 1 次搜索此刻才返回（陈旧）：必须被丢弃
		resolveFirst({ packages: [{ name: "stale" }], total: 9, page: 1 });
		await p1;
		expect(useCatalogStore.getState().catalogPackages).toEqual([{ name: "new" }]);
		expect(useCatalogStore.getState().catalogTotal).toBe(1);
	});
});
