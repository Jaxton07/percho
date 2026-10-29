import type { ProviderInfo } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 模型目录自动刷新（spec D3）· **真实 store 路径**测试。
 *
 * 覆盖：触发面（本地/联网各是谁发的）、single-flight（重复入口只一次）、发布仲裁（晚回的旧 local 不覆盖新 network）、
 * 写盘世代（变更后的重读不复用旧读取、不复活已删 provider）、失败保留列表 + 可重试、被拒结果不触发 loadModels、
 * 跨类别一个先结束不卡 spinner、本地加载不等待网络。
 *
 * 面板挂载侧的触发次数（进分类=1 / 子 tab=0 / 重开=1 / 其他分类=0）由 CDP 探针覆盖（组件测试基建是 SSR markup，无 effect）。
 */

const api = vi.hoisted(() => ({
	listProviders: vi.fn(),
	listSubagents: vi.fn(),
	getLoadedResources: vi.fn(),
	getPermissionConfig: vi.fn(),
	getChannelWatchConfig: vi.fn(),
	lanGetStatus: vi.fn(),
	getModelPrefs: vi.fn(),
	loadModels: vi.fn(),
	addCustomProvider: vi.fn(),
	updateCustomProvider: vi.fn(),
	removeCustomProvider: vi.fn(),
	saveApiKey: vi.fn(),
	removeCredential: vi.fn(),
	setProviderBaseUrl: vi.fn(),
	installPackage: vi.fn(),
	removePackage: vi.fn(),
	listConfiguredPackages: vi.fn(),
	startProviderLogin: vi.fn(),
	onProviderLoginEvent: vi.fn(),
}));
vi.mock("../api", () => ({
	getPi: () =>
		Object.assign(api, {
			forEnvironment: (environment: { kind: string }) => {
				if (environment.kind !== "local") throw new Error("Unexpected remote fixture");
				return api;
			},
		}),
}));
const toasts = vi.hoisted(() => ({ pushToast: vi.fn() }));
vi.mock("./toasts", () => ({ pushToast: toasts.pushToast }));
// settings store 只用到 sessions store 的 activeSessionId + loadModels
const sessionsState = vi.hoisted(() => ({ activeSessionId: null as string | null, loadModels: vi.fn() }));
vi.mock("./sessions", () => ({ useSessionsStore: { getState: () => sessionsState } }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/** 取数组第 n 项（noUncheckedIndexedAccess 下显式失败，比非空断言更好定位） */
function at<T>(list: T[], index: number): T {
	const item = list[index];
	if (item === undefined) throw new Error(`期望存在第 ${index} 项`);
	return item;
}

const providers = (...ids: string[]): ProviderInfo[] =>
	ids.map((id) => ({ id, name: id, models: [], requiresAuth: false }) as unknown as ProviderInfo);

/** 每次 listProviders 调用是否走的联网（forceNetwork） */
const coldCalls = () => api.listProviders.mock.calls.map((call) => call[0]?.options?.forceNetwork === true);

let store: typeof import("./settings").useSettingsStore;

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	api.getPermissionConfig.mockResolvedValue({ enabled: true });
	api.getChannelWatchConfig.mockResolvedValue({ enabled: true });
	api.lanGetStatus.mockResolvedValue(null);
	api.getModelPrefs.mockResolvedValue({ hiddenModels: {}, subagentModels: {} });
	api.getLoadedResources.mockResolvedValue({
		skills: [],
		skillDiagnostics: [],
		extensions: [],
		extensionErrors: [],
	});
	api.listSubagents.mockResolvedValue([]);
	api.loadModels.mockResolvedValue(undefined);
	for (const mutation of [
		api.saveApiKey,
		api.removeCredential,
		api.addCustomProvider,
		api.updateCustomProvider,
		api.removeCustomProvider,
		api.setProviderBaseUrl,
	])
		mutation.mockResolvedValue(undefined);
	sessionsState.activeSessionId = null;
	sessionsState.loadModels = api.loadModels;
	store = (await import("./settings")).useSettingsStore;
});

describe("V03 settings consumer matrix (ticket 11 target)", () => {
	it("import is lazy; category changes and closing perform no requests", () => {
		expect(store.getState().permissionGateOff).toBeNull();
		store.getState().setCategory("general");
		store.getState().setOpen(false);
		for (const mock of Object.values(api)) expect(mock).not.toHaveBeenCalled();
	});
	it("refresh reads all local domains once; resources are conditional on an active session", async () => {
		api.listProviders.mockResolvedValue([]);
		await store.getState().refresh();
		for (const mock of [
			api.getPermissionConfig,
			api.getChannelWatchConfig,
			api.lanGetStatus,
			api.getModelPrefs,
			api.listProviders,
			api.listSubagents,
		]) {
			expect(mock).toHaveBeenCalledTimes(1);
		}
		expect(api.getLoadedResources).not.toHaveBeenCalled();
		expect(coldCalls()).toEqual([false]);
		sessionsState.activeSessionId = "active";
		await store.getState().refresh();
		expect(api.getLoadedResources).toHaveBeenCalledWith({ sessionId: "active" });
	});
	it("reopening general rereads permission/general but never LAN or model domains", async () => {
		api.listProviders.mockResolvedValue([]);
		store.getState().setCategory("general");
		store.getState().setOpen(true);
		await store.getState().loadPermissionGate();
		expect(api.getPermissionConfig).toHaveBeenCalledTimes(1);
		expect(api.lanGetStatus).not.toHaveBeenCalled();
		store.getState().setOpen(false);
		api.getPermissionConfig.mockResolvedValue({ enabled: false });
		store.getState().openWith("general");
		await vi.waitFor(() => expect(store.getState().permissionGateOff).toBe(true));
		expect(api.getPermissionConfig).toHaveBeenCalledTimes(2);
		expect(api.lanGetStatus).not.toHaveBeenCalled();
		expect(api.getChannelWatchConfig).toHaveBeenCalledTimes(2);
		expect(coldCalls()).toEqual([]);
	});
});

describe("D10 consumer and mutation responsibilities", () => {
	it.each([
		"general",
		"models",
		"skills",
		"extensions",
		"lan",
		"appearance",
		"mcp",
		"about",
		"remote",
		"plugin:test",
	])("openWith(%s) only reads its settings domains plus the shared gate", async (category) => {
		api.listProviders.mockResolvedValue([]);
		sessionsState.activeSessionId = "matrix-session";
		store.getState().openWith(category as import("./settings").SettingsCategory);
		await store.getState().loadPermissionGate();
		const full = category.startsWith("plugin:");
		if (full) await vi.waitFor(() => expect(api.getLoadedResources).toHaveBeenCalledOnce());
		for (const [mock, enabled] of [
			[api.getChannelWatchConfig, full || category === "general"],
			[api.listProviders, full || category === "models"],
			[api.getModelPrefs, full || category === "models"],
			[api.listSubagents, full || category === "models"],
			[api.getLoadedResources, full || category === "skills" || category === "extensions"],
			[api.lanGetStatus, full || category === "lan"],
		] as const)
			expect(mock).toHaveBeenCalledTimes(enabled ? 1 : 0);
		expect(api.getPermissionConfig).toHaveBeenCalledOnce();
	});
	it("closed category/same category/read-once marker never turns into TTL; reentry reads again without clearing other domains", async () => {
		api.listProviders.mockResolvedValue(providers("kept"));
		await store.getState().refresh();
		const kept = store.getState().providers;
		vi.clearAllMocks();
		store.getState().setCategory("appearance");
		expect(api.getPermissionConfig).not.toHaveBeenCalled();
		store.getState().setOpen(true);
		await store.getState().loadPermissionGate();
		store.getState().setOpen(true);
		store.getState().setCategory("appearance");
		store.getState().openWith("appearance");
		expect(api.getPermissionConfig).toHaveBeenCalledOnce();
		expect(api.listProviders).not.toHaveBeenCalled();
		expect(store.getState().providers).toBe(kept);
		store.getState().setCategory("general");
		expect(api.getChannelWatchConfig).toHaveBeenCalledOnce();
		store.getState().setCategory("general");
		expect(api.getChannelWatchConfig).toHaveBeenCalledOnce();
		store.getState().setOpen(false);
		store.getState().setOpen(true);
		await store.getState().loadPermissionGate();
		expect(api.getPermissionConfig).toHaveBeenCalledTimes(2);
	});
	it("independent gate startup coalesces pending reads and retries after failure, then reopens detect edited config", async () => {
		const gate = deferred<{ enabled: boolean }>();
		api.getPermissionConfig.mockReturnValueOnce(gate.promise);
		const startup = store.getState().loadPermissionGate();
		expect(store.getState().loadPermissionGate()).toBe(startup);
		store.getState().openWith("appearance");
		expect(api.getPermissionConfig).toHaveBeenCalledOnce();
		gate.reject(Error("gate read"));
		await startup;
		expect(store.getState().permissionGateOff).toBeNull();
		api.getPermissionConfig.mockResolvedValue({ enabled: false });
		await store.getState().loadPermissionGate();
		expect(store.getState().permissionGateOff).toBe(true);
		store.getState().setOpen(false);
		api.getPermissionConfig.mockResolvedValue({ enabled: true });
		store.getState().setOpen(true);
		await store.getState().loadPermissionGate();
		expect(store.getState().permissionGateOff).toBe(false);
		expect(api.getPermissionConfig).toHaveBeenCalledTimes(3);
	});
	it.each(["provider", "packages"] as const)(
		"%s mutation refresh preserves catalog generation/models while avoiding general/gate/LAN",
		async (domain) => {
			api.listProviders.mockResolvedValue(providers("changed"));
			sessionsState.activeSessionId = "mutation-session";
			await store.getState().refreshAfterMutation(domain);
			expect(api.listProviders).toHaveBeenCalledOnce();
			expect(api.getModelPrefs).toHaveBeenCalledOnce();
			expect(api.listSubagents).toHaveBeenCalledOnce();
			expect(api.loadModels).toHaveBeenCalledOnce();
			expect(api.getLoadedResources).toHaveBeenCalledTimes(domain === "packages" ? 1 : 0);
			for (const mock of [api.getPermissionConfig, api.getChannelWatchConfig, api.lanGetStatus])
				expect(mock).not.toHaveBeenCalled();
		},
	);
	it.each(["failed", "cancelled"] as const)(
		"actual login %s keeps its existing error/cancel ownership and never refreshes domains",
		async (outcome) => {
			const off = vi.fn();
			api.onProviderLoginEvent.mockReturnValue(off);
			api.startProviderLogin.mockResolvedValue(
				outcome === "failed" ? { ok: false, error: "login denied" } : { ok: false, cancelled: true },
			);
			const login = (await import("./provider-login")).useProviderLoginStore;
			await login.getState().startProviderLogin(providers("login-provider")[0] as ProviderInfo);
			expect(off).toHaveBeenCalledOnce();
			if (outcome === "failed") expect(login.getState().login?.error).toBe("login denied");
			else expect(login.getState().login).toBeNull();
			for (const mock of [
				api.loadModels,
				api.listProviders,
				api.getModelPrefs,
				api.getLoadedResources,
				api.getPermissionConfig,
				api.lanGetStatus,
			])
				expect(mock).not.toHaveBeenCalled();
		},
	);
	it("full refresh retains silent LAN read while LAN panel owns its visible error", async () => {
		api.listProviders.mockRejectedValue(Error("catalog denied"));
		api.lanGetStatus.mockRejectedValue(Error("lan denied"));
		await store.getState().refresh();
		expect(store.getState().error).toBe("catalog denied");
		store.getState().openWith("lan");
		await vi.waitFor(() => expect(store.getState().error).toBe("lan denied"));
	});
	it("actual package install/remove and login success delegate the domain mutation entry, without broad refresh", async () => {
		api.listProviders.mockResolvedValue([]);
		api.listConfiguredPackages.mockResolvedValue([]);
		api.installPackage.mockResolvedValue(undefined);
		api.removePackage.mockResolvedValue(undefined);
		sessionsState.activeSessionId = "packages";
		const catalog = (await import("./catalog")).useCatalogStore;
		await catalog.getState().installCatalogPackage("fixture");
		await vi.waitFor(() => expect(api.loadModels).toHaveBeenCalledTimes(1));
		await catalog.getState().removeConfiguredPackage("fixture", "user");
		await vi.waitFor(() => expect(api.loadModels).toHaveBeenCalledTimes(2));
		expect(api.getLoadedResources).toHaveBeenCalledTimes(2);
		const off = vi.fn();
		api.onProviderLoginEvent.mockReturnValue(off);
		api.startProviderLogin.mockResolvedValue({ ok: true });
		const login = (await import("./provider-login")).useProviderLoginStore;
		await login.getState().startProviderLogin(providers("login-provider")[0] as ProviderInfo);
		expect(api.loadModels).toHaveBeenCalledTimes(3);
		expect(api.getLoadedResources).toHaveBeenCalledTimes(2);
		expect(off).toHaveBeenCalledOnce();
		expect(login.getState().login).toBeNull();
		for (const mock of [api.getPermissionConfig, api.getChannelWatchConfig, api.lanGetStatus])
			expect(mock).not.toHaveBeenCalled();
	});
});

describe("D3 触发面：谁发请求", () => {
	it("打开设置 / 进模型分类（refresh）只走本地目录，不发联网请求", async () => {
		api.listProviders.mockResolvedValue(providers("local-a"));
		await store.getState().refresh();
		expect(coldCalls()).toEqual([false]);
		expect(store.getState().providers.map((p) => p.id)).toEqual(["local-a"]);
		expect(store.getState().loading).toBe(false);
		expect(api.loadModels).not.toHaveBeenCalled(); // 本地目录不触发选择器刷新（与改造前一致）
	});

	it("联网刷新走 forceNetwork，并在**有效发布**后刷新 Composer 模型选择器", async () => {
		api.listProviders.mockResolvedValue(providers("net-a"));
		await store.getState().refreshProvidersFromNetwork();
		expect(coldCalls()).toEqual([true]);
		expect(store.getState().providers.map((p) => p.id)).toEqual(["net-a"]);
		expect(store.getState().refreshing).toBe(false);
		expect(api.loadModels).toHaveBeenCalledTimes(1);
	});

	it("重复入口（进分类自动 + 手动点击）共享同一个在途请求：只发一次联网", async () => {
		const gate = deferred<ProviderInfo[]>();
		api.listProviders.mockReturnValue(gate.promise);
		const a = store.getState().refreshProvidersFromNetwork();
		const b = store.getState().refreshProvidersFromNetwork();
		const c = store.getState().refreshProvidersFromNetwork();
		expect(coldCalls()).toEqual([true]);
		expect(store.getState().refreshing).toBe(true); // 手动按钮据此禁用
		gate.resolve(providers("net-a"));
		await Promise.all([a, b, c]);
		expect(store.getState().providers.map((p) => p.id)).toEqual(["net-a"]);
		expect(api.loadModels).toHaveBeenCalledTimes(1); // 三个入口只刷新一次选择器
		expect(store.getState().refreshing).toBe(false);
	});

	it("重新进入分类（在途已结算后再次触发）会再发一次联网", async () => {
		api.listProviders.mockResolvedValue(providers("net-a"));
		await store.getState().refreshProvidersFromNetwork();
		await store.getState().refreshProvidersFromNetwork();
		expect(coldCalls()).toEqual([true, true]);
	});
});

describe("D3 发布仲裁：晚回的旧结果不覆盖新结果", () => {
	it("旧本地结果晚于联网结果返回：被拒绝，联网结果保留", async () => {
		const localGate = deferred<ProviderInfo[]>();
		const netGate = deferred<ProviderInfo[]>();
		api.listProviders.mockImplementation((arg?: { options?: { forceNetwork?: boolean } }) =>
			arg?.options?.forceNetwork ? netGate.promise : localGate.promise,
		);
		const local = store.getState().refresh();
		const network = store.getState().refreshProvidersFromNetwork();
		netGate.resolve(providers("net-fresh"));
		await network;
		expect(store.getState().providers.map((p) => p.id)).toEqual(["net-fresh"]);
		localGate.resolve(providers("local-stale"));
		await local;
		expect(store.getState().providers.map((p) => p.id)).toEqual(["net-fresh"]);
		expect(store.getState().loading).toBe(false);
		expect(store.getState().refreshing).toBe(false);
	});

	it("跨类别：本地在途 + 联网先结束，loading/refreshing 都不卡住", async () => {
		const localGate = deferred<ProviderInfo[]>();
		const netGate = deferred<ProviderInfo[]>();
		api.listProviders.mockImplementation((arg?: { options?: { forceNetwork?: boolean } }) =>
			arg?.options?.forceNetwork ? netGate.promise : localGate.promise,
		);
		const local = store.getState().refresh();
		const network = store.getState().refreshProvidersFromNetwork();
		netGate.resolve(providers("net"));
		await network;
		localGate.resolve(providers("local"));
		await local;
		expect(store.getState().loading).toBe(false);
		expect(store.getState().refreshing).toBe(false);
	});

	it("本地设置加载不等待联网：联网请求在途时 refresh() 照常落地本地数据", async () => {
		const netGate = deferred<ProviderInfo[]>();
		api.listProviders.mockImplementation((arg?: { options?: { forceNetwork?: boolean } }) =>
			arg?.options?.forceNetwork ? netGate.promise : Promise.resolve(providers("local")),
		);
		void store.getState().refreshProvidersFromNetwork(); // 自动联网（永不结算）
		await store.getState().refresh();
		expect(store.getState().providers.map((p) => p.id)).toEqual(["local"]);
		expect(store.getState().loading).toBe(false);
		expect(store.getState().refreshing).toBe(true); // 联网仍在途
		netGate.resolve(providers("net-late"));
		await Promise.resolve();
	});
});

describe("D3 写盘世代：变更后的重读与并发目录", () => {
	it("删除 provider 后：先发的联网结果晚回，不能复活它；重读是新发的一次读取", async () => {
		const netGate = deferred<ProviderInfo[]>();
		const reads: Array<ReturnType<typeof deferred<ProviderInfo[]>>> = [];
		api.listProviders.mockImplementation((arg?: { options?: { forceNetwork?: boolean } }) => {
			if (arg?.options?.forceNetwork) return netGate.promise;
			const gate = deferred<ProviderInfo[]>();
			reads.push(gate);
			return gate.promise;
		});
		api.removeCustomProvider.mockResolvedValue(undefined);

		const local = store.getState().refresh(); // 面板打开时的本地读取（在途）
		const network = store.getState().refreshProvidersFromNetwork(); // 自动联网（在途，含要被删的 custom-x）
		const remove = store.getState().removeCustom("custom-x"); // 用户删除（写盘成功 → afterMutation）
		await vi.waitFor(() => expect(reads).toHaveLength(2));
		expect(reads.length).toBe(2); // 写盘后的重读**新发**一次，没复用写盘前那次
		at(reads, 1).resolve(providers("keep"));
		await remove;
		expect(store.getState().providers.map((p) => p.id)).toEqual(["keep"]);
		expect(api.loadModels).toHaveBeenCalled(); // 变更后仍刷新选择器数据（沿用改造前行为）

		netGate.resolve(providers("keep", "custom-x")); // 联网结果晚回（含已删除的 provider）
		await network;
		expect(store.getState().providers.map((p) => p.id)).toEqual(["keep"]);

		at(reads, 0).resolve(providers("keep", "custom-x")); // 写盘前那次本地读取也晚回
		await local;
		expect(store.getState().providers.map((p) => p.id)).toEqual(["keep"]);
		expect(store.getState().loading).toBe(false);
	});

	it("被拒的旧联网结果不触发 loadModels（副作用只在有效发布后）", async () => {
		const netGate = deferred<ProviderInfo[]>();
		const reads: Array<ReturnType<typeof deferred<ProviderInfo[]>>> = [];
		api.listProviders.mockImplementation((arg?: { options?: { forceNetwork?: boolean } }) => {
			if (arg?.options?.forceNetwork) return netGate.promise;
			const gate = deferred<ProviderInfo[]>();
			reads.push(gate);
			return gate.promise;
		});
		api.removeCustomProvider.mockResolvedValue(undefined);

		const network = store.getState().refreshProvidersFromNetwork();
		const remove = store.getState().removeCustom("custom-x");
		await vi.waitFor(() => expect(reads).toHaveLength(1));
		at(reads, 0).resolve(providers("keep"));
		await remove;
		expect(api.loadModels).toHaveBeenCalledTimes(1); // 变更路径的那次

		netGate.resolve(providers("keep", "custom-x")); // 旧世代 ⇒ 被拒
		await network;
		expect(api.loadModels).toHaveBeenCalledTimes(1); // 联网结果被拒 ⇒ 不额外刷新选择器
		expect(store.getState().providers.map((p) => p.id)).toEqual(["keep"]);
	});

	it("同类别的旧读取不清新读取的 loading（并发 local 不误清）", async () => {
		const reads: Array<ReturnType<typeof deferred<ProviderInfo[]>>> = [];
		api.listProviders.mockImplementation(() => {
			const gate = deferred<ProviderInfo[]>();
			reads.push(gate);
			return gate.promise;
		});
		api.saveApiKey.mockResolvedValue(undefined);

		const first = store.getState().refresh(); // 旧 local（在途）
		const save = store.getState().saveKey("p", "k"); // 写盘 → 新 local
		await vi.waitFor(() => expect(reads).toHaveLength(2));
		expect(reads.length).toBe(2);
		at(reads, 0).resolve(providers("stale"));
		await first;
		expect(store.getState().loading).toBe(true); // 新读取仍在途
		at(reads, 1).resolve(providers("fresh"));
		await save;
		expect(store.getState().providers.map((p) => p.id)).toEqual(["fresh"]);
		expect(store.getState().loading).toBe(false);
	});
});

describe("D3 失败语义", () => {
	it("联网失败：保留已有列表、清 refreshing、置 error，重试成功后发布并清 error", async () => {
		store.setState({ providers: providers("cached") });
		api.listProviders.mockRejectedValueOnce(new Error("network unreachable"));
		await store.getState().refreshProvidersFromNetwork();
		expect(store.getState().providers.map((p) => p.id)).toEqual(["cached"]);
		expect(store.getState().refreshing).toBe(false);
		expect(store.getState().error).toBe("network unreachable");
		expect(api.loadModels).not.toHaveBeenCalled();

		api.listProviders.mockResolvedValue(providers("recovered"));

		await store.getState().refreshProvidersFromNetwork();
		expect(store.getState().providers.map((p) => p.id)).toEqual(["recovered"]);
		expect(store.getState().error).toBeNull();
		expect(api.loadModels).toHaveBeenCalledTimes(1);
	});

	it("本地读取失败：loading 收干净、error 置上，已加载的 providers 保留", async () => {
		store.setState({ providers: providers("cached"), loading: false });
		api.listProviders.mockRejectedValue(new Error("disk error"));
		await store.getState().refresh();
		expect(store.getState().loading).toBe(false);
		expect(store.getState().error).toBe("disk error");
		expect(store.getState().providers.map((p) => p.id)).toEqual(["cached"]);
	});

	it("旧请求的失败不覆盖新请求的结论", async () => {
		const netGate = deferred<ProviderInfo[]>();
		const localGate = deferred<ProviderInfo[]>();
		api.listProviders.mockImplementation((arg?: { options?: { forceNetwork?: boolean } }) =>
			arg?.options?.forceNetwork ? netGate.promise : localGate.promise,
		);
		const network = store.getState().refreshProvidersFromNetwork(); // 旧号
		const local = store.getState().refresh(); // 新号
		localGate.resolve(providers("local-new"));
		await local;
		netGate.reject(new Error("network down")); // 旧号失败
		await network;
		expect(store.getState().error).toBeNull();
		expect(store.getState().providers.map((p) => p.id)).toEqual(["local-new"]);
	});
});

describe("D3 重构不吞其他发布：prefs / subagents / 已加载资源", () => {
	it("目录走协调器后，prefs、subagents、已加载资源仍各自发布", async () => {
		sessionsState.activeSessionId = "s1";
		api.listProviders.mockResolvedValue(providers("p1"));
		api.listSubagents.mockResolvedValue([{ name: "scout" }] as never);
		api.getModelPrefs.mockResolvedValue({ hiddenModels: { a: true }, subagentModels: {} } as never);
		api.getLoadedResources.mockResolvedValue({
			skills: [{ name: "x" }],
			skillDiagnostics: [{ level: "warn" }],
			extensions: [{ name: "y" }],
			extensionErrors: [{ name: "z" }],
		} as never);

		await store.getState().refresh();

		expect(api.getModelPrefs).toHaveBeenCalled();
		expect(api.listSubagents).toHaveBeenCalled();
		expect(api.getLoadedResources).toHaveBeenCalledWith({ sessionId: "s1" });
		expect(store.getState().providers.map((p) => p.id)).toEqual(["p1"]);
		expect(store.getState().subagents).toEqual([{ name: "scout" }]);
		expect(store.getState().modelPrefs).toEqual({ hiddenModels: { a: true }, subagentModels: {} });
		expect(store.getState().skills).toEqual([{ name: "x" }]);
		expect(store.getState().extensions).toEqual([{ name: "y" }]);
	});

	it("目录请求失败也不影响 prefs 与已加载资源的独立发布", async () => {
		sessionsState.activeSessionId = "s1";
		api.listProviders.mockRejectedValue(new Error("disk error"));
		api.getModelPrefs.mockResolvedValue({ hiddenModels: {}, subagentModels: {} } as never);
		api.getLoadedResources.mockResolvedValue({
			skills: [{ name: "x" }],
			skillDiagnostics: [],
			extensions: [],
			extensionErrors: [],
		} as never);

		await store.getState().refresh();

		expect(store.getState().error).toBe("disk error");
		expect(store.getState().modelPrefs).toEqual({ hiddenModels: {}, subagentModels: {} });
		expect(store.getState().skills).toEqual([{ name: "x" }]);
	});

	it("新会话页（无活跃会话）不取已加载资源，资源字段置空", async () => {
		sessionsState.activeSessionId = null;
		store.setState({ skills: [{ name: "old" }] as never, extensions: [{ name: "old" }] as never });
		api.listProviders.mockResolvedValue(providers("p1"));
		await store.getState().refresh();
		expect(api.getLoadedResources).not.toHaveBeenCalled();
		expect(store.getState().skills).toBeNull();
		expect(store.getState().extensions).toBeNull();
	});
});

describe("D3 写盘世代：每个变更入口都必须推进", () => {
	const mutations: Array<
		[string, (store: typeof import("./settings").useSettingsStore) => Promise<unknown>]
	> = [
		["saveKey", (s) => s.getState().saveKey("p", "k")],
		["removeCredential", (s) => s.getState().removeCredential("p")],
		["addCustom", (s) => s.getState().addCustom({} as never)],
		["updateCustom", (s) => s.getState().updateCustom({} as never)],
		["removeCustom", (s) => s.getState().removeCustom("p")],
		["setProviderBaseUrl", (s) => s.getState().setProviderBaseUrl("p", "https://x")],
	];

	for (const [name, run] of mutations) {
		it(`${name} 推进写盘世代：不复用写盘前的在途读取，旧读取晚回不回灌`, async () => {
			const reads: Array<ReturnType<typeof deferred<ProviderInfo[]>>> = [];
			api.listProviders.mockImplementation(() => {
				const gate = deferred<ProviderInfo[]>();
				reads.push(gate);
				return gate.promise;
			});

			const preMutation = store.getState().refresh(); // 写盘前发出的读取（在途）
			const mutation = run(store);
			await vi.waitFor(() => expect(reads.length).toBe(2)); // 写盘后**新发**一次读取

			at(reads, 1).resolve(providers("post-mutation"));
			await mutation;
			expect(store.getState().providers.map((p) => p.id)).toEqual(["post-mutation"]);

			at(reads, 0).resolve(providers("pre-mutation"));
			await preMutation;
			expect(store.getState().providers.map((p) => p.id)).toEqual(["post-mutation"]);
			expect(store.getState().loading).toBe(false);
		});
	}
});

describe("D3 子代理清单独立发布（review R3）", () => {
	it("联网先回、本地目录后回：子代理清单仍按本地读取发布，不被目录仲裁淘汰", async () => {
		const localGate = deferred<ProviderInfo[]>();
		const netGate = deferred<ProviderInfo[]>();
		api.listSubagents.mockResolvedValue([{ name: "scout" }] as never);
		api.listProviders.mockImplementation((arg?: { options?: { forceNetwork?: boolean } }) =>
			arg?.options?.forceNetwork ? netGate.promise : localGate.promise,
		);
		const local = store.getState().refresh();
		const network = store.getState().refreshProvidersFromNetwork();
		netGate.resolve(providers("net"));
		await network;
		localGate.resolve(providers("local"));
		await local;
		expect(store.getState().providers.map((p) => p.id)).toEqual(["net"]);
		expect(store.getState().subagents).toEqual([{ name: "scout" }]);
	});

	it("目录读取失败但子代理清单成功：清单仍落地", async () => {
		api.listProviders.mockRejectedValue(new Error("disk error"));
		api.listSubagents.mockResolvedValue([{ name: "scout" }] as never);
		await store.getState().refresh();
		expect(store.getState().error).toBe("disk error");
		expect(store.getState().subagents).toEqual([{ name: "scout" }]);
	});

	it("子代理清单失败但目录成功：目录仍落地 + 走 toast（不去抢 error 字段）", async () => {
		api.listProviders.mockResolvedValue(providers("p1"));
		api.listSubagents.mockRejectedValue(new Error("subagents boom"));
		await store.getState().refresh();
		expect(store.getState().providers.map((p) => p.id)).toEqual(["p1"]);
		expect(store.getState().error).toBeNull();
		expect(toasts.pushToast).toHaveBeenCalledWith("warning", "toast.subagentsLoadFailed", "subagents boom");
	});

	it("两次子代理读取乱序：旧清单不回灌", async () => {
		const gates: Array<ReturnType<typeof deferred<unknown[]>>> = [];
		api.listProviders.mockResolvedValue(providers("p"));
		api.listSubagents.mockImplementation(() => {
			const gate = deferred<unknown[]>();
			gates.push(gate);
			return gate.promise as never;
		});
		const first = store.getState().refresh();
		const second = store.getState().refresh();
		await vi.waitFor(() => expect(gates.length).toBe(2));
		at(gates, 1).resolve([{ name: "new" }]);
		await second;
		expect(store.getState().subagents).toEqual([{ name: "new" }]);
		at(gates, 0).resolve([{ name: "old" }]);
		await first;
		expect(store.getState().subagents).toEqual([{ name: "new" }]);
	});
});

describe("D3 非目录读取失败的可见提示（review R4）", () => {
	it("modelPrefs 读取失败：走 toast、不覆盖目录 error；重试成功后偏好正常发布", async () => {
		api.listProviders.mockRejectedValue(new Error("disk error"));
		api.getModelPrefs.mockRejectedValueOnce(new Error("prefs boom"));
		await store.getState().refresh();
		await vi.waitFor(() =>
			expect(toasts.pushToast).toHaveBeenCalledWith("warning", "toast.modelPrefsLoadFailed", "prefs boom"),
		);
		expect(store.getState().error).toBe("disk error"); // 目录 error 没被非目录失败抢走

		api.listProviders.mockResolvedValue(providers("p1"));
		api.getModelPrefs.mockResolvedValue({ hiddenModels: { a: true }, subagentModels: {} } as never);
		await store.getState().refresh();
		expect(store.getState().modelPrefs).toEqual({ hiddenModels: { a: true }, subagentModels: {} });
		expect(store.getState().error).toBeNull();
	});

	it("已加载资源读取失败：走 toast，且与目录 error 同时存在时互不吞", async () => {
		sessionsState.activeSessionId = "s1";
		api.listProviders.mockRejectedValue(new Error("disk error"));
		api.getLoadedResources.mockRejectedValue(new Error("resources boom"));
		await store.getState().refresh();
		expect(store.getState().error).toBe("disk error");
		expect(toasts.pushToast).toHaveBeenCalledWith("warning", "toast.loadedResourcesFailed", "resources boom");
	});

	it("已加载资源失败后可重试成功", async () => {
		sessionsState.activeSessionId = "s1";
		api.listProviders.mockResolvedValue(providers("p1"));
		api.getLoadedResources.mockRejectedValueOnce(new Error("resources boom"));
		await store.getState().refresh();
		expect(store.getState().skills).toBeNull();
		api.getLoadedResources.mockResolvedValue({
			skills: [{ name: "x" }],
			skillDiagnostics: [],
			extensions: [],
			extensionErrors: [],
		} as never);
		await store.getState().refresh();
		expect(store.getState().skills).toEqual([{ name: "x" }]);
	});
});
